import { Injectable } from '@nestjs/common';
import type {
  MapsSearchResult,
  MapsAutocompleteResult,
  MapsPlaceDetailsResult,
  MapsPlacePhotoResult,
  MapsReverseResult,
  MapsResolveUrlResult,
} from '@trek/shared';
import { readEnv, getAppUrl } from '../../app-config';
import { safeFetchFollow, SsrfBlockedError } from '../../utils/ssrfGuard';
import { discardBody, exceedsDeclaredLength, readCappedText } from '../../utils/cappedFetch';
import { resolveApiKey, type ApiKeySource } from '../settings/instance-api-keys';
// ── Photo cache (disk-backed) ────────────────────────────────────────────────
import { PlacePhotoCacheService } from '../place-photos/place-photo-cache.service';
import { DatabaseService } from '../database/database.service';
import { nominatimFetch, type GeoLane } from '../geo/nominatim.client';
import {
  trekPlacesSearch,
  trekPlacesById,
  trekPlacesArea,
  trekPlacesNearby,
  toPlaceRecord,
  POI_CATEGORY_TO_TREK,
} from './trek-places.client';
import {
  UA,
  SEARCH_TEXT_FIELD_MASK,
  toApiLang,
  googleFtidFromMapsUrl,
  buildOsmDetails,
  normalizeOpeningPeriods,
  normalizeSpecialDays,
  isGooglePlaceId,
  OSM_PLACE_ID,
  CATEGORY_OSM_FILTERS,
  resolveOverpassEndpoints,
  resolveOverpassTimeoutMs,
  stripWikiMarkup,
  parseWikipediaTag,
  toWikiLang,
  haversineMetres,
  namesOverlap,
  mergeSearchResults,
  type GoogleOpeningHours,
  type OverpassPoi,
} from './maps.helpers';

// ── Google API call counter ───────────────────────────────────────────────────

let googleApiCallCount = 0;

/** The upstream every Places call is written against. */
const PLACES_UPSTREAM = 'https://places.googleapis.com';

/**
 * Sends the call somewhere else when PLACES_API_BASE is set.
 *
 * The nine Places endpoints below all spell out the upstream host, so an install
 * that wants these calls to leave through something of its own — an egress proxy,
 * a cache, a gateway holding the key — has no way to say so today. One variable,
 * substituted at the one place every call funnels through.
 *
 * Path and query are untouched, so the replacement has to speak the same API.
 * Unset, which is every install today, the string is returned as it came in.
 */
function placesEndpoint(endpoint: string): string {
  const base = readEnv().maps.placesApiBase;
  if (!base || !endpoint.startsWith(PLACES_UPSTREAM)) return endpoint;
  // The character before the run is matched and written straight back. A bare
  // /\/+$/ restarts at every slash of a base that does not end in one, reading
  // the rest of the run again from each of them.
  return base.replace(/([^/]|^)\/+$/, '$1') + endpoint.slice(PLACES_UPSTREAM.length);
}

/**
 * Says which of the three credentials Google rejected, never which value.
 *
 * The response body Google sends ("The caller does not have permission") is
 * identical whichever key was used, so without this line a report of "works for
 * the admin, fails for everyone else" cannot be told apart from a genuinely
 * broken key.
 */
function logKeyFailure(label: string, status: number, userId: number, source: ApiKeySource | null): void {
  console.error(`[Maps] ${label} failed with ${status} userId=${userId} keySource=${source}`);
}

function googleFetch(rawEndpoint: string, label: string, init?: RequestInit): Promise<Response> {
  const endpoint = placesEndpoint(rawEndpoint);
  googleApiCallCount++;
  console.debug(`[Google API] #${googleApiCallCount} ${label} → ${endpoint}`);
  const referer = readEnv().app.appUrl ? getAppUrl() : undefined;
  return fetch(endpoint, {
    ...init,
    headers: { ...(referer ? { Referer: referer } : {}), ...((init?.headers as Record<string, string>) ?? {}) },
  });
}

// ── Interfaces ───────────────────────────────────────────────────────────────

interface NominatimResult {
  osm_type: string;
  osm_id: string;
  name?: string;
  display_name?: string;
  lat: string;
  lon: string;
  extratags?: Record<string, string> | null;
}

/**
 * The keys that say which encyclopaedia entry, Wikidata item and Commons
 * category describe a place. Everything the enrichment column shows beyond
 * coordinates hangs off one of these.
 *
 * Bare keys only. OSM also carries `brand:wikidata` / `brand:wikipedia`, and
 * following those means a branch of a chain gets the chain's article and the
 * chain's logo — for "L'Osteria Rostock" you would confidently describe
 * L'Osteria the company. That is the exact failure the tag-only rule was
 * written to avoid, so do not "improve" this by falling back to brand:*.
 */
const WIKI_IDENTITY_TAGS = ['wikipedia', 'wikidata', 'wikimedia_commons'] as const;

export interface WikiIdentity {
  wikipedia: string | null;
  wikidata: string | null;
  wikimedia_commons: string | null;
}

interface WikidataSnak {
  mainsnak?: { datavalue?: { value?: string } };
  rank?: 'preferred' | 'normal' | 'deprecated';
}
type WikidataClaims = Record<string, WikidataSnak[] | undefined>;

/**
 * Wikidata properties that name a picture of a place, in the order we want them.
 *
 * P18 is the representative image. The rest exist because a station or a
 * monument is not one view: asking for the interior, the night shot, the
 * panorama and the aerial gives a picker four genuinely different pictures
 * instead of four frames of the same façade.
 */
const WIKIDATA_IMAGE_PROPERTIES = [
  'P18', // image
  'P5775', // interior view
  'P3451', // night view
  'P8592', // aerial view
  'P4291', // panoramic view
  'P5252', // winter view
  'P948', // Wikivoyage banner
] as const;

/** First non-empty string value of a claim list. */
function claimValue(snaks: WikidataSnak[] | undefined): string | null {
  for (const snak of snaks ?? []) {
    const value = snak.mainsnak?.datavalue?.value;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * File names from an item's picture properties, best first.
 *
 * Within P18 the statement rank decides: an item with several images marks one
 * `preferred`, and that is the one an editor considers representative. The API
 * returns statements in edit order, not rank order, so taking `[0]` picks
 * whichever was added first — for the Brandenburg Gate that is a coin toss
 * between the morning shot and a wide overview.
 */
function wikidataImageClaims(claims: WikidataClaims, limit: number): string[] {
  const rankOrder = { preferred: 0, normal: 1, deprecated: 2 } as const;
  const names: string[] = [];
  const seen = new Set<string>();

  for (const property of WIKIDATA_IMAGE_PROPERTIES) {
    const snaks = [...(claims[property] ?? [])]
      .filter((snak) => snak.rank !== 'deprecated')
      .sort((a, b) => (rankOrder[a.rank ?? 'normal'] ?? 1) - (rankOrder[b.rank ?? 'normal'] ?? 1));
    for (const snak of snaks) {
      const value = snak.mainsnak?.datavalue?.value;
      if (typeof value !== 'string' || !value.trim()) continue;
      const key = normalizeFileTitle(value);
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(value.trim());
      if (names.length >= limit) return names;
    }
  }
  return names;
}

/** `File:` prefix off, underscores and case normalised — Commons treats these as one title. */
function normalizeFileTitle(title: string): string {
  return title.replace(/^File:/i, '').replaceAll('_', ' ').trim().toLowerCase();
}

/**
 * A bare Commons category name out of whatever an OSM `wikimedia_commons` tag
 * holds.
 *
 * The tag is free text and mappers put three different things in it: a bare
 * name, a prefixed `Category:…`, or — against the wiki's own advice — a single
 * `File:…`. Prefixing blindly turned the last one into `Category:File:X.jpg`,
 * which matches nothing and fell through to the coordinate search without a
 * word. Localised prefixes (`Kategorie:`) appear too.
 */
function normalizeCategoryName(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  // A file name is not a category, and there is nothing sensible to derive.
  if (/^(file|datei|image|bild)\s*:/i.test(value)) return null;
  return value.replace(/^(category|kategorie|categorie|categoría|categoria)\s*:/i, '').trim() || null;
}

/**
 * The chain a place belongs to, when it belongs to one.
 *
 * Read separately from `readWikiIdentity` and never mixed into it. Following
 * `brand:wikidata` as if it described the place is how "L'Osteria Rostock"
 * ends up illustrated with the company logo and described as a franchise
 * operator — which is why the picture ladder never sees these. For a
 * description they are still worth something: a branch of a chain has no
 * article of its own and never will, and "L'Osteria is a German restaurant
 * chain serving pizza and pasta" beats an empty column, as long as the reader
 * is told that is what they are looking at.
 */
export function readBrandIdentity(extratags: Record<string, string> | null | undefined): {
  wikidata: string | null;
  wikipedia: string | null;
} {
  const read = (key: string): string | null => {
    const value = extratags?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  return { wikidata: read('brand:wikidata'), wikipedia: read('brand:wikipedia') };
}

/** Picks the three identity tags out of a Nominatim `extratags` blob. */
export function readWikiIdentity(extratags: Record<string, string> | null | undefined): WikiIdentity {
  const out: WikiIdentity = { wikipedia: null, wikidata: null, wikimedia_commons: null };
  if (!extratags) return out;
  for (const tag of WIKI_IDENTITY_TAGS) {
    const value = extratags[tag];
    if (typeof value === 'string' && value.trim()) out[tag] = value.trim();
  }
  return out;
}

interface OverpassElement {
  tags?: Record<string, string>;
}

interface WikiCommonsPage {
  pageid?: number;
  title?: string;
  imageinfo?: {
    url?: string;
    thumburl?: string;
    mime?: string;
    width?: number;
    height?: number;
    /** The file description page — where the full licence terms live. */
    descriptionurl?: string;
    extmetadata?: {
      Artist?: { value?: string };
      LicenseShortName?: { value?: string };
      LicenseUrl?: { value?: string };
      UsageTerms?: { value?: string };
      /** Used to spot survey imagery and diagrams, which are not pictures of a place. */
      Categories?: { value?: string };
      ObjectName?: { value?: string };
      ImageDescription?: { value?: string };
    };
  }[];
}

/**
 * One Commons image with everything needed to credit it. Commons is mostly
 * CC BY / CC BY-SA, so a candidate that cannot be attributed is not usable in a
 * picker — the fields are nullable because Commons metadata is user-maintained
 * and genuinely incomplete on some files, not because they are optional to show.
 */
export interface CommonsCandidate {
  photoUrl: string;
  attribution: string | null;
  license: string | null;
  licenseUrl: string | null;
  sourceUrl: string | null;
  /**
   * Commons page id — the only stable identity a file has across the four ways
   * we reach it. The thumbnail URL is not: the same file comes back from
   * commons.wikimedia.org and from a language Wikipedia with different query
   * strings, so deduplicating on the URL silently lets the same picture through
   * twice. It is also what keys the cached bytes, so it must survive.
   */
  pageId: number | null;
  /** File page title, e.g. `File:Brandenburger Tor morgens.jpg`. */
  title: string | null;
  width: number | null;
  height: number | null;
  /** Free text used to reject survey imagery, floor plans and logos. */
  descriptors: string | null;
}

interface GooglePlaceResult {
  id: string;
  displayName?: { text: string };
  /** OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY. Absent on non-business results. */
  businessStatus?: string;
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  rating?: number;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  types?: string[];
  googleMapsUri?: string;
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
  regularOpeningHours?: GoogleOpeningHours;
  editorialSummary?: { text: string };
  reviews?: {
    authorAttribution?: { displayName?: string; photoUri?: string };
    rating?: number;
    text?: { text?: string };
    relativePublishTimeDescription?: string;
  }[];
  photos?: { name: string; authorAttributions?: { displayName?: string }[] }[];
}

// ── Concurrency limiter for outbound photo fetches ───────────────────────────
// Caps simultaneous Wikimedia/Google photo requests so a bulk import of hundreds
// of places cannot monopolise the event loop or trigger external API rate limits.
// Module-scoped ON PURPOSE (permissions-cache precedent): the bridge instance and
// the DI singleton must share one limiter, one POI cache and one call counter.
// Wikimedia is normally well under a second, but a cold TLS handshake from a
// fresh container has been seen at eight. Enrichment answers a live dialog, so
// a slow provider is dropped rather than waited out.
// A Google Maps place page is a few hundred KB; the coordinates sit in the
// embedded map data near the top, so two megabytes is plenty and keeps an
// unbounded body out of memory.
const MAX_MAPS_PAGE_BYTES = 2_000_000;

const GOOGLE_SHORT_HOSTS = ['goo.gl', 'maps.app.goo.gl'];

/**
 * Google Maps lives on every country domain — google.de, maps.google.co.uk,
 * google.com.au — so the host is matched by shape. A fixed list of .com hosts
 * would quietly stop resolving the ccTLD links people actually paste. The TLD
 * labels stay short (2-3 letters, optionally two of them) so that
 * `google.evil.com` is not a Google host.
 */
function isGoogleMapsHost(hostname: string): boolean {
  return GOOGLE_SHORT_HOSTS.includes(hostname)
    || /^(www\.|maps\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(hostname);
}

const WIKI_TIMEOUT_MS = 6000;

// Tighter than the wiki calls, because this one sits at the FRONT of a chain:
// identity, then sitelinks, then the extract. Nominatim answers a bounded
// search in 0.2-0.7s in practice, so anything past a couple of seconds is a bad
// day at the provider rather than a slow answer worth waiting for.
const IDENTITY_TIMEOUT_MS = 2500;

const MAX_CONCURRENT_PHOTO_FETCHES = 5;
let photoFetchActive = 0;
const photoFetchQueue: Array<() => void> = [];

function acquirePhotoFetchSlot(): Promise<void> {
  if (photoFetchActive < MAX_CONCURRENT_PHOTO_FETCHES) {
    photoFetchActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => photoFetchQueue.push(resolve));
}

function releasePhotoFetchSlot(): void {
  const next = photoFetchQueue.shift();
  if (next) {
    next();
  } else {
    photoFetchActive--;
  }
}

/**
 * Runs an outbound photo fetch under the shared slot limit. Exported so the
 * enrichment module queues behind the same five slots — a picker that grabs
 * three images per selected place would otherwise sail past a cap the rest of
 * the app respects.
 */
export async function withPhotoFetchSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquirePhotoFetchSlot();
  try {
    return await fn();
  } finally {
    releasePhotoFetchSlot();
  }
}

// ── Overpass POI search state ────────────────────────────────────────────────

interface OverpassPoiElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface PoiSearchResult {
  pois: OverpassPoi[];
  source: 'openstreetmap';
  truncated: boolean;
  // True when the requested viewport was too large and got shrunk to a centred
  // window before querying — the results then cover the middle of the view only.
  clamped: boolean;
}

// Frozen at module load, same timing as the legacy service ("frozen on purpose",
// see src/app-config/README.md).
const OVERPASS_MIRRORS = resolveOverpassEndpoints();
const OVERPASS_TIMEOUT_MS = resolveOverpassTimeoutMs();
// Largest viewport side we send to Overpass. A country/continent-sized bbox makes
// Overpass scan millions of elements and time out; clamping to a centred window
// keeps the query cheap so the explore pill returns fast at ANY zoom level.
const MAX_BBOX_SPAN_DEG = 0.5;

// Short-lived cache so panning back over / re-toggling the same area doesn't
// re-hit Overpass. Keyed by category + rounded (post-clamp) bbox.
const POI_CACHE = new Map<string, { at: number; value: PoiSearchResult }>();
const POI_CACHE_TTL_MS = 5 * 60 * 1000;
// Cap the number of cached areas so panning across the globe can't grow the map
// without bound (entries are evicted oldest-first once the cap is reached).
const POI_CACHE_MAX = 500;

// POST the query to all mirrors at once and return the first one that answers with
// valid JSON. Throws {status:502} only if every mirror fails. Racing (rather than
// trying one-by-one) keeps latency at the fastest reachable mirror instead of the
// sum of every dead mirror's timeout.
async function overpassFetch(query: string): Promise<OverpassPoiElement[]> {
  const body = `data=${encodeURIComponent(query)}`;
  const controllers: AbortController[] = [];

  const attempt = async (url: string): Promise<OverpassPoiElement[]> => {
    const ctrl = new AbortController();
    controllers.push(ctrl);
    const timer = setTimeout(() => ctrl.abort(), OVERPASS_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Overpass ${res.status} @ ${url}`);
      const data = (await res.json()) as { elements?: OverpassPoiElement[]; remark?: string };
      // Overpass signals an internal timeout / runtime error via `remark` while
      // still answering HTTP 200 — often fast, with an empty or partial element
      // set. Treat that as a failed attempt so a healthy mirror wins the race
      // instead of this fast-but-empty answer, and so the all-mirrors-failed path
      // still surfaces a real error to the client instead of a silent "no places".
      if (data.remark) throw new Error(`Overpass remark @ ${url}: ${data.remark}`);
      if (!Array.isArray(data.elements)) throw new Error(`Overpass non-OSM body @ ${url}`);
      return data.elements;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    // Promise.any resolves with the first mirror to return valid JSON, and only
    // rejects (AggregateError) once every mirror has failed.
    return await Promise.any(OVERPASS_MIRRORS.map(attempt));
  } catch (err) {
    // Log WHY every endpoint failed (connection refused, aborted/timed out, non-OSM
    // body, …) so an operator can tell blocked egress / a firewall from a transiently
    // overloaded mirror — otherwise this is a bare 502 with no breadcrumb (see #1309).
    const reasons =
      err instanceof AggregateError
        ? err.errors.map((e) => (e instanceof Error ? e.message : String(e))).join(' | ')
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(`[Overpass] all ${OVERPASS_MIRRORS.length} endpoint(s) failed — ${reasons}`);
    throw Object.assign(new Error('Could not reach any Overpass endpoint'), { status: 502 });
  } finally {
    // Cancel the slower/losing requests — we already have (or have given up on) a result.
    controllers.forEach((c) => {
      try {
        c.abort();
      } catch {
        /* noop */
      }
    });
  }
}

type LocationBias = { low: { lat: number; lng: number }; high: { lat: number; lng: number } };

/**
 * /api/maps domain service — geocoding, the provider fan-out
 * (Nominatim/Overpass/Google), the place-details/photo caches and the SSRF
 * guard on every outbound URL. DI-native since the maps fold: the legacy
 * services/mapsService.ts functions live here as methods over the injected
 * DatabaseService (byte-identical SQL and behaviour). Every consumer injects
 * this class; pure helpers live in maps.helpers.ts.
 *
 * The per-endpoint kill-switches are settings reads the legacy route does
 * inline; they're encapsulated here as `*Disabled()` helpers over the same
 * `app_settings` rows.
 */
@Injectable()
export class MapsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly photoCache: PlacePhotoCacheService,
  ) {}

  private isSettingDisabled(key: string): boolean {
    const row = this.database.get<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = ?',
      key,
    );
    return row?.value === 'false';
  }

  /**
   * Fail-OPEN, unlike the three Google switches: the index is the path we want
   * people on, and an install that upgrades without visiting the admin panel
   * should land on it rather than stay on Nominatim, whose usage policy forbids
   * what TREK was doing with it.
   */
  trekPlacesEnabled(): boolean {
    const row = this.database.get<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'trek_places_enabled'",
    );
    return row?.value !== 'false';
  }

  /**
   * The places in a trip's area, for the offline cache.
   *
   * The one call TREK makes that is not driven by something a user just typed.
   * It runs when a trip is prepared for offline use, alongside the map tiles,
   * and it is the reason searching a trip works on a plane: without it the
   * offline instance has the trip's own places and nothing else, so "find a
   * pharmacy near the hotel" has nothing to answer from.
   *
   * Returns null rather than throwing when the index is switched off or the
   * service is unreachable, because this is a nice-to-have running in the
   * background of a sync — a failure here must not fail the sync.
   */
  async placesInArea(
    bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number },
    limit?: number,
  ): Promise<{ results: Record<string, unknown>[]; truncated: boolean } | null> {
    if (!this.trekPlacesEnabled()) return null;
    try {
      const area = await trekPlacesArea(bbox, limit);
      return { results: area.results.map(toPlaceRecord), truncated: area.truncated };
    } catch (err) {
      console.warn('TREK Places area lookup failed:', (err as Error).message);
      return null;
    }
  }

  autocompleteDisabled(): boolean {
    return this.isSettingDisabled('places_autocomplete_enabled');
  }

  detailsDisabled(): boolean {
    return this.isSettingDisabled('places_details_enabled');
  }

  photosDisabled(): boolean {
    return this.isSettingDisabled('places_photos_enabled');
  }

  // ── Controller-facing surface (unchanged signatures) ───────────────────────

  search(userId: number, query: string, lang?: string, locationBias?: { lat: number; lng: number; radius?: number }): Promise<MapsSearchResult> {
    return this.searchPlaces(userId, query, lang, locationBias) as Promise<MapsSearchResult>;
  }

  autocomplete(userId: number, input: string, lang?: string, locationBias?: LocationBias, sessionToken?: string): Promise<MapsAutocompleteResult> {
    return this.autocompletePlaces(userId, input, lang, locationBias, sessionToken) as Promise<MapsAutocompleteResult>;
  }

  details(userId: number, placeId: string, lang?: string, sessionToken?: string): Promise<MapsPlaceDetailsResult> {
    return this.getPlaceDetails(userId, placeId, lang, sessionToken) as Promise<MapsPlaceDetailsResult>;
  }

  detailsExpanded(userId: number, placeId: string, lang: string | undefined, refresh: boolean): Promise<MapsPlaceDetailsResult> {
    return this.getPlaceDetailsExpanded(userId, placeId, lang, refresh) as Promise<MapsPlaceDetailsResult>;
  }

  photo(userId: number, placeId: string, lat: number, lng: number, name?: string): Promise<MapsPlacePhotoResult> {
    return this.getPlacePhoto(userId, placeId, lat, lng, name) as Promise<MapsPlacePhotoResult>;
  }

  photoBytesKey(placeId: string): Promise<string | null> {
    return this.photoCache.serveKey(placeId);
  }

  reverse(lat: string, lng: string, lang?: string): Promise<MapsReverseResult> {
    return this.reverseGeocode(lat, lng, lang) as Promise<MapsReverseResult>;
  }

  resolveUrl(url: string): Promise<MapsResolveUrlResult> {
    return this.resolveGoogleMapsUrl(url) as Promise<MapsResolveUrlResult>;
  }

  // POI search by category within a viewport. Never calls Google.
  //
  // The index answers first: it holds the same places, indexed in an R-Tree, and
  // the public Overpass mirrors this used to depend on are regularly overloaded.
  // A miss or a failure drops through to Overpass exactly as before.
  async pois(
    category: string,
    bbox: { south: number; west: number; north: number; east: number },
    lang?: string,
  ): Promise<PoiSearchResult> {
    const terms = POI_CATEGORY_TO_TREK[category];
    if (this.trekPlacesEnabled() && terms) {
      try {
        const lat = (bbox.south + bbox.north) / 2;
        const lng = (bbox.west + bbox.east) / 2;
        // Half the diagonal, so the circle covers the viewport corners rather
        // than leaving the edges of the map empty.
        const wanted = Math.round(
          Math.hypot(
            (bbox.north - bbox.south) * 111_320,
            (bbox.east - bbox.west) * 111_320 * Math.cos((lat * Math.PI) / 180),
          ) / 2,
        );
        const radius = Math.min(20000, Math.max(300, wanted));
        const found = await trekPlacesNearby(lat, lng, {
          radius,
          limit: 50,
          category: terms.join(','),
        });
        if (found.length > 0) {
          // Same shape the Overpass path produces, so the client and the map
          // renderer need no branch. `source` stays 'openstreetmap' because it
          // is a typed contract the client switches on, and the places are the
          // same places; where they came from is an implementation detail of
          // this method, not something the pill should render differently.
          return {
            pois: found.map(p => ({
              osm_id: `gers:${p.gers}`,
              name: p.name,
              lat: p.lat,
              lng: p.lng,
              category,
              poi_type: p.category ?? category,
              address: p.address?.freeform ?? null,
              website: p.contact?.website ?? null,
              phone: p.contact?.phone ?? null,
              opening_hours: p.hours?.osm ?? null,
              // The index has no cuisine field, so this null is the truth
              // rather than a field being dropped on the way through.
              cuisine: null,
              source: 'openstreetmap' as const,
            })),
            source: 'openstreetmap' as const,
            truncated: found.length >= 50,
            // A wide viewport is narrowed here too, and the caller is told so
            // for the same reason the Overpass path tells it.
            clamped: radius < wanted,
          };
        }
      } catch (err: unknown) {
        console.warn('TREK Places nearby failed, falling back:', (err as Error).message);
      }
    }
    return this.searchOverpassPois(category, bbox, lang);
  }

  // ── API key retrieval ──────────────────────────────────────────────────────

  /**
   * The Places credential for this request, and where it came from.
   *
   * Operator env first: a per-user key would route around whatever the
   * operator's endpoint counts, and unset, that branch never runs. Then the
   * instance-wide value the admin panel writes, then the caller's own row.
   *
   * What is deliberately gone is the old third step, "any admin's key" (#1939):
   * it read a stranger's credential, which server/CLAUDE.md forbids, and made
   * the answer depend on who was asking — the saving admin got their own key,
   * everybody else got the lowest-id admin's and a 403 from Google. The source
   * is returned so a provider error can say which of the three was used.
   */
  resolveMapsKey(userId: number): { key: string | null; source: ApiKeySource | null } {
    return resolveApiKey(this.database, 'maps_api_key', userId, readEnv().maps.placesApiKey);
  }

  getMapsKey(userId: number): string | null {
    return this.resolveMapsKey(userId).key;
  }

  /**
   * A coordinate for a name that came out of an import, from whichever source
   * has it.
   *
   * Booking imports geocode every venue and every uncoordinated endpoint in one
   * request loop, up to thirty sequential lookups. Every one of those used to be
   * a Nominatim call on the background lane, waiting out its throttle. The index
   * answers most of them without leaving our own infrastructure and without a
   * throttle at all; a street address it does not know still falls through to
   * Nominatim, which is the source that resolves addresses.
   *
   * Never throws: an import that cannot place a hotel still imports the hotel.
   */
  async geocodeQuery(query: string): Promise<{ lat: number; lng: number } | null> {
    if (this.trekPlacesEnabled()) {
      try {
        const found = await trekPlacesSearch(query, { limit: 1 });
        const hit = found[0];
        if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lng)) {
          return { lat: hit.lat, lng: hit.lng };
        }
      } catch (err: unknown) {
        console.warn('TREK Places geocode failed, falling back:', (err as Error).message);
      }
    }
    const hit = (await this.searchNominatim(query, undefined, 'background'))[0];
    return hit?.lat != null && hit?.lng != null ? { lat: hit.lat, lng: hit.lng } : null;
  }

  // ── Nominatim search ───────────────────────────────────────────────────────

  /**
   * `lane` defaults to interactive because most callers are a keystroke.
   *
   * Bulk callers must pass 'background': booking-import geocodes every venue and
   * every uncoordinated endpoint of an import in one request loop, which is up
   * to thirty sequential calls. On the interactive lane those thirty take the
   * next slot each time, so somebody typing in the place search waits behind the
   * whole import. Yielding does not make the import faster, it stops it from
   * being the only thing the process will do for half a minute.
   */
  async searchNominatim(
    query: string,
    lang?: string,
    lane: GeoLane = 'interactive',
    bias?: { lat: number; lng: number },
  ) {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      addressdetails: '1',
      // Free, same request: this is where a place's wikidata/wikipedia/commons
      // tags live. Without them the enrichment column can only fall back to
      // "photos taken within 300m", which around a city centre is passers-by
      // and the neighbouring building.
      extratags: '1',
      limit: '10',
      'accept-language': toApiLang(lang),
    });
    // Prefer the area the caller is looking at, never restrict to it
    // (bounded=0). Without this, "Hase-dera" returns the temple of that name in
    // Nara rather than the one in Kamakura the user is standing next to; with
    // bounded=1 a search for somewhere genuinely far away would return nothing.
    if (bias) {
      const d = 0.5;
      params.set('viewbox', [bias.lng - d, bias.lat - d, bias.lng + d, bias.lat + d].join(','));
      params.set('bounded', '0');
    }
    // Through the shared client: one throttle for the whole process.
    const response = await nominatimFetch('search', params, { lane });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Nominatim API error: ${response.status} ${response.statusText}${text ? ' - ' + text.substring(0, 200) : ''}`,
      );
    }
    const data = (await response.json()) as NominatimResult[];
    return data.map((item) => {
      // Number.isFinite, not `|| null`: a place on the equator or prime
      // meridian has a legitimate 0 coordinate.
      const lat = Number.parseFloat(item.lat);
      const lng = Number.parseFloat(item.lon);
      return {
        google_place_id: null,
        google_ftid: null,
        osm_id: `${item.osm_type}:${item.osm_id}`,
        name: item.name || item.display_name?.split(',')[0] || '',
        address: item.display_name || '',
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        rating: null,
        website: null,
        phone: null,
        source: 'openstreetmap',
        ...readWikiIdentity(item.extratags),
      };
    });
  }

  /**
   * Finds the OpenStreetMap record for a place we only know by name and
   * coordinate, and hands back its tags.
   *
   * This is what gives a Google place a free identity. Google's payload has no
   * `wikidata`, no `wikipedia` and no `wikimedia_commons` — it never had — so
   * without this the entire free half of the enrichment column is unreachable
   * for anyone who configured a Google key, which is the opposite of how this
   * feature is meant to work. OSM knows these places perfectly well; nobody was
   * asking it.
   *
   * Two gates keep it from describing the wrong building, because a confident
   * description of somewhere else is worse than none:
   *   - the match has to be within `maxDistanceM` of where we are looking, and
   *   - it has to share a substantial word with the name we are looking for.
   * Among what survives, Nominatim's own `importance` decides — that is what
   * separates the Brandenburg Gate from the underground station named after it.
   */
  async resolveOsmIdentity(
    name: string,
    lat: number,
    lng: number,
    opts: { lang?: string; maxDistanceM?: number; signal?: AbortSignal } = {},
  ): Promise<{ tags: Record<string, string>; osmUrl: string | null; matchedName: string } | null> {
    const query = (name || '').trim();
    if (!query || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const maxDistanceM = opts.maxDistanceM ?? 2000;

    // ~2km box around the point, so Nominatim ranks locally instead of handing
    // back the most famous place on earth with this name.
    const d = 0.02;
    const params = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      extratags: '1',
      limit: '5',
      bounded: '1',
      viewbox: `${lng - d},${lat - d},${lng + d},${lat + d}`,
      'accept-language': toApiLang(opts.lang),
    });

    try {
      // The caller's deadline is handed in rather than built here, so the
      // throttle wait cannot eat it before the request starts.
      const res = await nominatimFetch('search', params, {
        signal: opts.signal,
        timeoutMs: IDENTITY_TIMEOUT_MS,
      });
      if (!res.ok) return null;
      // Nominatim answers rate limiting in plain text, not JSON.
      const data = (await res.json()) as (NominatimResult & { importance?: number })[];
      if (!Array.isArray(data)) return null;

      const best = data
        .map((item) => ({
          item,
          lat: Number.parseFloat(item.lat),
          lng: Number.parseFloat(item.lon),
        }))
        .filter(({ item, lat: hitLat, lng: hitLng }) => {
          if (!Number.isFinite(hitLat) || !Number.isFinite(hitLng)) return false;
          if (haversineMetres(lat, lng, hitLat, hitLng) > maxDistanceM) return false;
          const label = item.name || item.display_name?.split(',')[0] || '';
          return namesOverlap(query, label);
        })
        .sort((a, b) => {
          const byImportance = (b.item.importance ?? 0) - (a.item.importance ?? 0);
          if (byImportance !== 0) return byImportance;
          return (
            haversineMetres(lat, lng, a.lat, a.lng) - haversineMetres(lat, lng, b.lat, b.lng)
          );
        })[0];

      if (!best) return null;
      return {
        tags: best.item.extratags ?? {},
        osmUrl:
          best.item.osm_type && best.item.osm_id
            ? `https://www.openstreetmap.org/${best.item.osm_type}/${best.item.osm_id}`
            : null,
        matchedName: best.item.name || best.item.display_name?.split(',')[0] || query,
      };
    } catch {
      return null;
    }
  }

  // ── Nominatim lookup (by OSM ID) ───────────────────────────────────────────

  async lookupNominatim(
    osmType: string,
    osmId: string,
    lang?: string,
  ): Promise<{
    name: string;
    address: string;
    lat: number | null;
    lng: number | null;
    extratags: Record<string, string> | null;
  } | null> {
    const typePrefix = osmType.charAt(0).toUpperCase(); // N, W, R
    const params = new URLSearchParams({
      osm_ids: `${typePrefix}${osmId}`,
      format: 'json',
      // Overpass is the richer source but it is also the one that times out;
      // whatever Nominatim already knows costs nothing extra here.
      extratags: '1',
      'accept-language': toApiLang(lang),
    });
    try {
      const res = await nominatimFetch('lookup', params);
      if (!res.ok) return null;
      const data = (await res.json()) as NominatimResult[];
      const item = data[0];
      if (!item) return null;
      const lat = Number.parseFloat(item.lat);
      const lng = Number.parseFloat(item.lon);
      return {
        name: item.name || item.display_name?.split(',')[0] || '',
        address: item.display_name || '',
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        extratags: item.extratags ?? null,
      };
    } catch {
      return null;
    }
  }

  // ── Overpass API (OSM details) ─────────────────────────────────────────────

  async fetchOverpassDetails(osmType: string, osmId: string): Promise<OverpassElement | null> {
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
      const data = (await res.json()) as { elements?: OverpassElement[] };
      return data.elements?.[0] || null;
    } catch {
      return null;
    }
  }

  // ── Overpass POI search (by category within a viewport bbox) ───────────────
  // Powers the "explore places on the map" pill. OSM-ONLY by design — this never
  // calls Google, even when a Google key is configured.

  async searchOverpassPois(
    category: string,
    bbox: { south: number; west: number; north: number; east: number },
    lang?: string,
    limit = 60,
  ): Promise<PoiSearchResult> {
    const filters = CATEGORY_OSM_FILTERS[category];
    if (!filters) throw Object.assign(new Error('Unknown POI category'), { status: 400 });

    // Clamp an oversized viewport to a centred window so the query stays cheap and
    // returns fast at any zoom, instead of timing out / 502-ing on a huge area.
    let { south, west, north, east } = bbox;
    let clamped = false;
    if (north - south > MAX_BBOX_SPAN_DEG) {
      const c = (north + south) / 2;
      south = c - MAX_BBOX_SPAN_DEG / 2;
      north = c + MAX_BBOX_SPAN_DEG / 2;
      clamped = true;
    }
    if (east - west > MAX_BBOX_SPAN_DEG) {
      const c = (east + west) / 2;
      west = c - MAX_BBOX_SPAN_DEG / 2;
      east = c + MAX_BBOX_SPAN_DEG / 2;
      clamped = true;
    }

    // OSM `name:*` tags are keyed by language subtag: prefer the user's language
    // (the same localization the search/autocomplete path asks the geocoder for)
    // over the native `name`. `int_name` is OSM's international/romanized name — a
    // sensible fallback before the native one. Part of the cache key so a cached
    // area isn't served with another language's titles.
    const osmLang = toApiLang(lang).split('-')[0].toLowerCase();

    // Serve repeat pans/toggles of the same area straight from the cache.
    const cacheKey = `${category}|${osmLang}|${south.toFixed(2)},${west.toFixed(2)},${north.toFixed(2)},${east.toFixed(2)}|${limit}`;
    const cached = POI_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.at < POI_CACHE_TTL_MS) return cached.value;
    if (cached) POI_CACHE.delete(cacheKey); // expired — drop it before refetching

    // Overpass wants the box as (south,west,north,east) = (minLat,minLng,maxLat,maxLng).
    const box = `(${south},${west},${north},${east})`;
    const selectors = filters
      .map((f) => {
        const [k, v] = f.split('=');
        return `  nwr["${k}"="${v}"]${box};`;
      })
      .join('\n');
    // `out center tags <n>` returns ways/relations with a computed center and caps
    // the result count in one round-trip.
    const query = `[out:json][timeout:20];\n(\n${selectors}\n);\nout center tags ${limit + 25};`;

    const elements = await overpassFetch(query);

    const pois: OverpassPoi[] = [];
    for (const el of elements) {
      const tags = el.tags || {};
      const name = tags[`name:${osmLang}`] || tags['int_name'] || tags.name || tags.brand || null;
      if (!name) continue; // unnamed POIs aren't useful to add to a plan
      // A shut-down place is not somewhere to plan a visit (#1341). OSM usually
      // re-tags one with a `disused:`/`abandoned:` prefix, and those never match
      // the selectors above — but plenty keep their original tag and gain a marker
      // instead, and those do come back. `opening_hours=closed`/`off` is the same
      // statement in the hours field.
      if (tags.disused === 'yes' || tags.abandoned === 'yes') continue;
      if (tags.opening_hours === 'closed' || tags.opening_hours === 'off') continue;
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat == null || lng == null) continue;
      const matched =
        filters.find((f) => {
          const [k, v] = f.split('=');
          return tags[k] === v;
        }) || filters[0];
      const addr =
        [tags['addr:street'], tags['addr:housenumber'], tags['addr:postcode'], tags['addr:city']]
          .filter(Boolean)
          .join(' ') || null;
      pois.push({
        osm_id: `${el.type}:${el.id}`,
        name,
        lat,
        lng,
        category,
        poi_type: matched,
        address: addr,
        website: tags.website || tags['contact:website'] || null,
        phone: tags.phone || tags['contact:phone'] || null,
        opening_hours: tags.opening_hours || null,
        cuisine: tags.cuisine || null,
        source: 'openstreetmap',
      });
    }
    const truncated = pois.length > limit;
    const value: PoiSearchResult = { pois: pois.slice(0, limit), source: 'openstreetmap', truncated, clamped };
    // FIFO eviction: a Map preserves insertion order, so the first key is the oldest.
    if (POI_CACHE.size >= POI_CACHE_MAX) POI_CACHE.delete(POI_CACHE.keys().next().value as string);
    POI_CACHE.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  // ── Wikimedia Commons photo lookup ─────────────────────────────────────────

  async fetchWikimediaPhoto(
    lat: number,
    lng: number,
    name?: string,
  ): Promise<{ photoUrl: string; attribution: string | null } | null> {
    // Strategy 1: Search Wikipedia for the place name -> get the article image
    if (name) {
      try {
        const searchParams = new URLSearchParams({
          action: 'query',
          format: 'json',
          titles: name,
          prop: 'pageimages',
          piprop: 'thumbnail',
          pithumbsize: '400',
          pilimit: '1',
          redirects: '1',
        });
        const res = await fetch(`https://en.wikipedia.org/w/api.php?${searchParams}`, { headers: { 'User-Agent': UA } });
        if (res.ok) {
          const data = (await res.json()) as { query?: { pages?: Record<string, { thumbnail?: { source?: string } }> } };
          const pages = data.query?.pages;
          if (pages) {
            for (const page of Object.values(pages)) {
              if (page.thumbnail?.source) {
                return { photoUrl: page.thumbnail.source, attribution: 'Wikipedia' };
              }
            }
          }
        }
      } catch {
        /* fall through to geosearch */
      }
    }

    // Strategy 2: Wikimedia Commons geosearch by coordinates
    const candidates = await this.fetchCommonsCandidates(lat, lng, 5);
    const first = candidates[0];
    return first ? { photoUrl: first.photoUrl, attribution: first.attribution } : null;
  }

  /**
   * Commons images near a coordinate, licence metadata included.
   *
   * geosearch already returns up to `limit` files in a single request, so asking
   * for a whole strip costs the same as asking for one picture. Callers that only
   * want a single image (fetchWikimediaPhoto, and through it getPlacePhoto) take
   * the first entry and get exactly the file they got before this existed.
   */
  /**
   * Anything photographed near a coordinate. The bottom rung of the picture
   * ladder, and the only one with no claim on the subject at all.
   *
   * 60 metres rather than the 300 it used to be. Three hundred metres in a city
   * centre is a whole block: the town hall, the church and the underground
   * entrance are all inside it, and every one of them outranks the doner shop
   * we were actually asked about. Sixty is roughly "the same building and its
   * neighbours", which is the widest a picture can be taken and still plausibly
   * show the place. It does not fix the real problem, which is that nobody
   * photographed the shop, but it stops the wrong answer from being confident.
   */
  async fetchCommonsCandidates(lat: number, lng: number, limit = 5): Promise<CommonsCandidate[]> {
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      generator: 'geosearch',
      ggsprimary: 'all',
      ggsnamespace: '6',
      ggsradius: '60',
      ggscoord: `${lat}|${lng}`,
      // Deliberately more than the caller asked for. Around anything worth
      // visiting the first few hits are survey tiles, passers-by and the
      // building next door; the ranker needs a pool to reject from, and
      // geosearch charges the same for one result as for twenty.
      ggslimit: String(Math.max(1, Math.min(Math.max(limit * 4, 8), 20))),
      prop: 'imageinfo',
      iiprop: 'url|extmetadata|mime|size',
      iiurlwidth: '400',
    });
    try {
      const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
        headers: { 'User-Agent': UA },
        // A hanging provider must not hold the whole enrichment request open;
        // no pictures is a fine answer, a request that never returns is not.
        signal: AbortSignal.timeout(WIKI_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { query?: { pages?: Record<string, WikiCommonsPage> } };
      // Hand back the whole pool. fetchWikimediaPhoto still takes [0] and gets
      // what it always got; the enrichment column ranks before it cuts.
      return this.toCommonsCandidates(data.query?.pages, Number(params.get('ggslimit')));
    } catch {
      return [];
    }
  }

  /** Shared shaping for every Commons query (coordinate, category, Wikidata, batch). */
  private toCommonsCandidates(
    pages: Record<string, WikiCommonsPage> | undefined,
    limit: number,
  ): CommonsCandidate[] {
    if (!pages) return [];
    const out: CommonsCandidate[] = [];
    // entries(), not values(): the map key is the page id, and for the queries
    // that reach a file by title it is the only place the id appears.
    for (const [key, page] of Object.entries(pages)) {
      const info = page.imageinfo?.[0];
      // Only use actual photos (JPEG/PNG), skip SVGs and PDFs
      const mime = info?.mime || '';
      if (!info?.url || !(mime.startsWith('image/jpeg') || mime.startsWith('image/png'))) continue;
      const meta = info.extmetadata;
      const pageId = page.pageid ?? (Number.isInteger(Number(key)) ? Number(key) : null);
      out.push({
        // iiurlwidth=400 makes Commons also return a scaled thumburl. Prefer it —
        // info.url is the full-resolution original (multi-megapixel camera exports).
        photoUrl: info.thumburl ?? info.url,
        attribution: stripWikiMarkup(meta?.Artist?.value),
        license: stripWikiMarkup(meta?.LicenseShortName?.value) ?? stripWikiMarkup(meta?.UsageTerms?.value),
        licenseUrl: meta?.LicenseUrl?.value?.trim() || null,
        sourceUrl: info.descriptionurl || null,
        pageId: pageId && pageId > 0 ? pageId : null,
        title: page.title ?? null,
        width: info.width ?? null,
        height: info.height ?? null,
        descriptors: [
          stripWikiMarkup(meta?.ObjectName?.value),
          stripWikiMarkup(meta?.ImageDescription?.value),
          stripWikiMarkup(meta?.Categories?.value),
        ]
          .filter(Boolean)
          .join(' | ') || null,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Lead paragraph of a wiki article, from Wikivoyage first and Wikipedia after.
   *
   * Wikivoyage is the travel sibling: same MediaWiki API, same CC BY-SA, but it
   * describes a place for someone about to go there, where Wikipedia opens with
   * area in square kilometres and pronunciation. Both are resolved from the OSM
   * `wikipedia` tag — guessing the article from the place name lands on the
   * wrong one for every ambiguous name, so no tag means no description rather
   * than a confident description of somewhere else.
   */
  async fetchWikiExtract(
    wikipediaTag: string | null | undefined,
  ): Promise<{ text: string; sourceUrl: string; source: 'wikivoyage' | 'wikipedia' } | null> {
    const parsed = parseWikipediaTag(wikipediaTag);
    if (!parsed) return null;

    // Two sentences, not three: this sits next to a form, and a fourth line of
    // prose pushes the pictures out of view.
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      titles: parsed.title,
      prop: 'extracts',
      exintro: '1',
      explaintext: '1',
      exsentences: '2',
      redirects: '1',
    });

    for (const host of ['wikivoyage', 'wikipedia'] as const) {
      const hit = await this.fetchWikiExtractFor(host, parsed.lang, parsed.title);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * The lead paragraph of one named article on one named wiki.
   *
   * Split out from `fetchWikiExtract` because the article is not always found
   * through an OSM tag: a place can carry a Wikidata id and no `wikipedia` tag
   * at all (Berlin Hauptbahnhof is exactly that), and then the title comes from
   * the item's sitelinks instead.
   */
  async fetchWikiExtractFor(
    host: 'wikivoyage' | 'wikipedia',
    lang: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; sourceUrl: string; source: 'wikivoyage' | 'wikipedia' } | null> {
    if (!lang || !title) return null;
    // Two sentences, not three: this sits next to a form, and a fourth line of
    // prose pushes the pictures out of view.
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      titles: title,
      prop: 'extracts',
      exintro: '1',
      explaintext: '1',
      exsentences: '2',
      redirects: '1',
    });
    try {
      const res = await fetch(`https://${lang}.${host}.org/w/api.php?${params}`, {
        headers: { 'User-Agent': UA },
        signal: signal ?? AbortSignal.timeout(WIKI_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        query?: { pages?: Record<string, { title?: string; extract?: string }> };
      };
      for (const page of Object.values(data.query?.pages ?? {})) {
        const text = page.extract?.trim();
        // A missing article comes back as a page with no extract, not a 404.
        if (!text) continue;
        const resolved = page.title ?? title;
        return {
          text,
          sourceUrl: `https://${lang}.${host}.org/wiki/${encodeURIComponent(resolved)}`,
          source: host,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Which articles a Wikidata item is linked to, for the wikis we care about.
   *
   * The way to an article when a place has a Wikidata id but no `wikipedia`
   * tag — which is most of them, because mappers add one or the other. One
   * request, a few hundred bytes.
   */
  async fetchWikidataSitelinks(
    wikidataId: string,
    sites: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    const qid = wikidataId.trim();
    if (!/^Q\d+$/.test(qid) || sites.length === 0) return {};
    const params = new URLSearchParams({
      action: 'wbgetentities',
      props: 'sitelinks',
      ids: qid,
      sitefilter: sites.join('|'),
      format: 'json',
    });
    try {
      const res = await fetch(`https://www.wikidata.org/w/api.php?${params}`, {
        headers: { 'User-Agent': UA },
        signal: signal ?? AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
      });
      if (!res.ok) return {};
      const data = (await res.json()) as {
        entities?: Record<string, { sitelinks?: Record<string, { title?: string }> }>;
      };
      const out: Record<string, string> = {};
      for (const [site, link] of Object.entries(data.entities?.[qid]?.sitelinks ?? {})) {
        if (link?.title) out[site] = link.title;
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * The pictures Wikidata records for a place, best first.
   *
   * By far the most accurate source there is: a person chose each of these to
   * represent this exact object, where a coordinate search only knows what was
   * photographed nearby. Wikidata also keeps them apart by what they show, so
   * asking for more than P18 buys genuine variety rather than another frame of
   * the same burst — Berlin Hauptbahnhof has an exterior, two interiors, a
   * night shot, a panorama and a winter view, all curated.
   *
   * Two calls total whatever the item holds: one for the claims, one batch for
   * the file metadata.
   */
  async fetchWikidataCandidates(
    wikidataId: string,
    limit = 5,
  ): Promise<{ candidates: CommonsCandidate[]; commonsCategory: string | null }> {
    const empty = { candidates: [], commonsCategory: null };
    const qid = wikidataId.trim();
    if (!/^Q\d+$/.test(qid)) return empty;
    try {
      const res = await fetch(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&props=claims&ids=${qid}&format=json`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(WIKI_TIMEOUT_MS) },
      );
      if (!res.ok) return empty;
      const data = (await res.json()) as { entities?: Record<string, { claims?: WikidataClaims }> };
      const claims = data.entities?.[qid]?.claims;
      if (!claims) return empty;

      const fileNames = wikidataImageClaims(claims, limit);
      const commonsCategory = claimValue(claims.P373) ?? null;
      if (fileNames.length === 0) return { candidates: [], commonsCategory };

      const byTitle = await this.fetchCommonsFilesByName(fileNames);
      // Back into the order Wikidata implied, which the batch response loses.
      const candidates = fileNames.map((name) => byTitle.get(normalizeFileTitle(name))).filter((c): c is CommonsCandidate => !!c);
      return { candidates, commonsCategory };
    } catch {
      return empty;
    }
  }

  /**
   * Metadata for a list of Commons files, in one request.
   *
   * `redirects=1` matters more than it looks: a Wikidata claim or a Wikipedia
   * lead image often names a file that has since been renamed, and without it
   * the API answers with a `missing` page and the picture disappears silently.
   * Keyed by normalised title so callers can restore their own ordering.
   */
  async fetchCommonsFilesByName(fileNames: string[]): Promise<Map<string, CommonsCandidate>> {
    const out = new Map<string, CommonsCandidate>();
    const titles = fileNames.map((name) => (/^File:/i.test(name) ? name : `File:${name}`));
    if (titles.length === 0) return out;

    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      titles: titles.join('|'),
      redirects: '1',
      prop: 'imageinfo',
      iiprop: 'url|extmetadata|mime|size',
      iiurlwidth: '400',
    });
    try {
      const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(WIKI_TIMEOUT_MS),
      });
      if (!res.ok) return out;
      const data = (await res.json()) as {
        query?: {
          pages?: Record<string, WikiCommonsPage>;
          normalized?: { from: string; to: string }[];
          redirects?: { from: string; to: string }[];
        };
      };
      // The API renames titles twice on the way in (normalisation, then
      // redirects), so walk the chain back to what the caller asked for.
      const aliases = new Map<string, string>();
      for (const hop of [...(data.query?.normalized ?? []), ...(data.query?.redirects ?? [])]) {
        aliases.set(normalizeFileTitle(hop.to), normalizeFileTitle(hop.from));
      }
      const resolveOriginal = (title: string): string => {
        let key = normalizeFileTitle(title);
        for (let hop = 0; hop < 4; hop++) {
          const previous = aliases.get(key);
          if (!previous || previous === key) break;
          key = previous;
        }
        return key;
      };

      for (const candidate of this.toCommonsCandidates(data.query?.pages, titles.length)) {
        if (!candidate.title) continue;
        out.set(resolveOriginal(candidate.title), candidate);
        // Also reachable under its own name, for callers that already resolved.
        out.set(normalizeFileTitle(candidate.title), candidate);
      }
      return out;
    } catch {
      return out;
    }
  }

  /**
   * The lead image a wiki article picked for a place.
   *
   * Only the file NAME is taken from here; the bytes and the licence come from
   * the same Commons batch as everything else. The thumbnail URL the API offers
   * alongside it carries no attribution, and a picture we cannot credit is a
   * picture we cannot show.
   */
  async fetchWikiLeadImageName(wikipediaTag: string | null | undefined): Promise<string | null> {
    const parsed = parseWikipediaTag(wikipediaTag);
    if (!parsed) return null;
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      titles: parsed.title,
      prop: 'pageimages',
      piprop: 'name',
      redirects: '1',
    });
    for (const host of ['wikivoyage', 'wikipedia'] as const) {
      try {
        const res = await fetch(`https://${parsed.lang}.${host}.org/w/api.php?${params}`, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(WIKI_TIMEOUT_MS),
        });
        if (!res.ok) continue;
        const data = (await res.json()) as {
          query?: { pages?: Record<string, { pageimage?: string }> };
        };
        for (const page of Object.values(data.query?.pages ?? {})) {
          if (page.pageimage) return page.pageimage;
        }
      } catch {
        /* try the next wiki */
      }
    }
    return null;
  }

  /**
   * Commons images from a category, which is the set of pictures OF a place.
   *
   * Preferred over the coordinate search wherever a place carries a
   * `wikimedia_commons` tag: geosearch around a city centre returns statues and
   * passers-by, while the category of a restaurant returns the restaurant.
   */
  async fetchCommonsCategoryCandidates(category: string, limit = 5): Promise<CommonsCandidate[]> {
    const name = normalizeCategoryName(category);
    if (!name) return [];
    // Overfetch: the ranker throws away survey imagery, diagrams and repeats,
    // and it can only do that from a pool bigger than the strip.
    const poolSize = String(Math.max(1, Math.min(limit * 3, 20)));

    // `generator=search` first. `categorymembers` orders by sort key, i.e.
    // alphabetically by file name, which is not a quality signal in any
    // direction: "Category:Brandenburg Gate" opens with an .ogg pronunciation,
    // a marathon photo and six near-identical press shots, and
    // "Category:Hamburg Airport" with a noise map and a terminal layout. The
    // search index at least ranks by how well a file matches its category.
    const search = new URLSearchParams({
      action: 'query',
      format: 'json',
      generator: 'search',
      gsrsearch: `incategory:"${name}" filetype:bitmap`,
      gsrnamespace: '6',
      gsrlimit: poolSize,
      prop: 'imageinfo',
      iiprop: 'url|extmetadata|mime|size',
      iiurlwidth: '400',
    });
    const members = new URLSearchParams({
      action: 'query',
      format: 'json',
      generator: 'categorymembers',
      gcmtitle: `Category:${name}`,
      gcmtype: 'file',
      gcmlimit: poolSize,
      prop: 'imageinfo',
      iiprop: 'url|extmetadata|mime|size',
      iiurlwidth: '400',
    });

    for (const params of [search, members]) {
      try {
        const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(WIKI_TIMEOUT_MS),
        });
        if (!res.ok) continue;
        const data = (await res.json()) as { query?: { pages?: Record<string, WikiCommonsPage> } };
        const hits = this.toCommonsCandidates(data.query?.pages, Number(poolSize));
        if (hits.length) return hits;
      } catch {
        /* fall through to the second strategy */
      }
    }
    return [];
  }

  /**
   * Photo references for a Google place, capped by the caller.
   *
   * Split out from the bytes download on purpose: this is one billed Details
   * call for the whole strip, while every reference turned into an image is a
   * separate billed /media call. Callers fetch bytes only for what they show.
   */
  async fetchGooglePhotoRefs(
    placeId: string,
    apiKey: string,
    cap: number,
  ): Promise<{ name: string; attribution: string | null }[]> {
    if (!isGooglePlaceId(placeId) || cap < 1) return [];
    try {
      const res = await googleFetch(
        `https://places.googleapis.com/v1/places/${placeId}`,
        `fetchGooglePhotoRefs(${placeId})`,
        { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'photos' } },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as GooglePlaceDetails;
      return (data.photos ?? []).slice(0, cap).map((photo) => ({
        name: photo.name,
        attribution: photo.authorAttributions?.[0]?.displayName || null,
      }));
    } catch {
      return [];
    }
  }

  /** Image bytes for one photo reference. Null on any miss; the caller skips it. */
  async fetchGooglePhotoBytes(photoName: string, apiKey: string, maxHeightPx = 400): Promise<Buffer | null> {
    try {
      const res = await googleFetch(
        `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=${maxHeightPx}`,
        `fetchGooglePhotoBytes(${photoName})`,
        { headers: { 'X-Goog-Api-Key': apiKey } },
      );
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      return bytes.length ? bytes : null;
    } catch {
      return null;
    }
  }

  /**
   * Google's editorial summary, on its own.
   *
   * getPlaceDetailsExpanded would also return this, but its field mask includes
   * `reviews`, which moves the call into the Enterprise SKU. Enrichment only
   * wants the sentence, so it asks for the sentence.
   */
  async fetchEditorialSummary(placeId: string, apiKey: string, lang?: string): Promise<string | null> {
    if (!isGooglePlaceId(placeId)) return null;
    try {
      const res = await googleFetch(
        `https://places.googleapis.com/v1/places/${placeId}?languageCode=${toApiLang(lang)}`,
        `fetchEditorialSummary(${placeId})`,
        { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'editorialSummary' } },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as GooglePlaceDetails;
      return data.editorialSummary?.text?.trim() || null;
    } catch {
      return null;
    }
  }

  // ── Search places (Google or Nominatim fallback) ───────────────────────────

  async searchPlaces(
    userId: number,
    query: string,
    lang?: string,
    locationBias?: { lat: number; lng: number; radius?: number },
  ): Promise<{ places: Record<string, unknown>[]; source: string }> {
    const { key: apiKey, source: keySource } = this.resolveMapsKey(userId);

    // The TREK index answers first, whether or not a Google key exists. It is
    // the only source here that may be stored, works offline as a country
    // package, and costs the caller nothing; a key buys ratings and photos on
    // top of it, not a better search.
    //
    // It never throws upward. A search that used to work must keep working when
    // the service is slow or down, so a failure drops through to exactly what
    // this method did before.
    if (this.trekPlacesEnabled()) {
      try {
        // Both at once. The index is a dataset of businesses and is very good
        // at those; OpenStreetMap is where the temples, bridges, riverside
        // walks and viewpoints are, and a travel search asks for those
        // constantly. Concurrently, so the pair costs the slower one rather
        // than the sum. This is the explicit search, not the keystroke path
        // Nominatim's policy rules out.
        const [found, osm] = await Promise.all([
          trekPlacesSearch(query, {
            lat: locationBias?.lat,
            lng: locationBias?.lng,
            limit: 10,
          }),
          this.searchNominatim(query, lang, 'interactive', locationBias).catch((err: unknown) => {
            console.warn('OpenStreetMap search failed, index only:', (err as Error).message);
            return [] as Record<string, unknown>[];
          }),
        ]);
        const places = mergeSearchResults(found.map(toPlaceRecord), osm);
        if (places.length > 0) {
          return {
            places,
            source: osm.length > 0 ? 'trek-places+openstreetmap' : 'trek-places',
          };
        }
      } catch (err: unknown) {
        // Logged, not surfaced: the fallback below is a working answer.
        console.warn('TREK Places search failed, falling back:', (err as Error).message);
      }
    }

    if (!apiKey) {
      const places = await this.searchNominatim(query, lang);
      return { places, source: 'openstreetmap' };
    }

    const searchBody: Record<string, unknown> = { textQuery: query, languageCode: toApiLang(lang) };
    // Bias results toward the caller's area when supplied — without it Google Text
    // Search falls back to the API key's billing region, which skews foreign-region queries.
    if (locationBias) {
      searchBody.locationBias = {
        circle: {
          center: { latitude: locationBias.lat, longitude: locationBias.lng },
          radius: locationBias.radius ?? 50000,
        },
      };
    }

    const response = await googleFetch('https://places.googleapis.com/v1/places:searchText', 'searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': SEARCH_TEXT_FIELD_MASK,
      },
      body: JSON.stringify(searchBody),
    });

    const data = (await response.json()) as { places?: GooglePlaceResult[]; error?: { message?: string } };

    if (!response.ok) {
      logKeyFailure('searchText', response.status, userId, keySource);
      const err = new Error(data.error?.message || 'Google Places API error') as Error & { status: number };
      err.status = response.status;
      throw err;
    }

    // A place that has shut down for good is never the answer to "where should we
    // go" (#1341). Temporarily closed stays: a restaurant on holiday next month is
    // still worth planning around. Anything without the field is a non-business
    // result (a park, a viewpoint) and is kept.
    const places = (data.places || [])
      .filter((p: GooglePlaceResult) => p.businessStatus !== 'CLOSED_PERMANENTLY')
      .map((p: GooglePlaceResult) => ({
      google_place_id: p.id,
      google_ftid: googleFtidFromMapsUrl(p.googleMapsUri),
      name: p.displayName?.text || '',
      address: p.formattedAddress || '',
      // `?? null`, not `|| null`: 0 is a real coordinate (equator / prime meridian).
      lat: p.location?.latitude ?? null,
      lng: p.location?.longitude ?? null,
      rating: p.rating || null,
      website: p.websiteUri || null,
      phone: p.nationalPhoneNumber || null,
      types: p.types || [],
      source: 'google',
    }));

    return { places, source: 'google' };
  }

  // ── Autocomplete (Google or Nominatim fallback) ────────────────────────────

  async autocompletePlaces(
    userId: number,
    input: string,
    lang?: string,
    locationBias?: { low: { lat: number; lng: number }; high: { lat: number; lng: number } },
    sessionToken?: string,
  ): Promise<{ suggestions: { placeId: string; mainText: string; secondaryText: string }[]; source: string }> {
    const { key: apiKey, source: keySource } = this.resolveMapsKey(userId);

    // This is the path that mattered most. Nominatim's usage policy names
    // autocomplete as unacceptable use in its own words, regardless of rate,
    // and the whole TREK fleet shares one User-Agent there: one abusive install
    // could get every instance blocked at once. The index removes that.
    //
    // Same contract as search: never throws upward, falls through to what this
    // method did before.
    if (this.trekPlacesEnabled()) {
      try {
        const centre = locationBias
          ? {
              lat: (locationBias.low.lat + locationBias.high.lat) / 2,
              lng: (locationBias.low.lng + locationBias.high.lng) / 2,
            }
          : undefined;
        const found = await trekPlacesSearch(input, { lat: centre?.lat, lng: centre?.lng, limit: 8 });
        if (found.length > 0) {
          return {
            suggestions: found.map(p => ({
              placeId: `gers:${p.gers}`,
              mainText: p.name,
              secondaryText: [p.address?.locality, p.address?.country].filter(Boolean).join(', '),
            })),
            source: 'trek-places',
          };
        }
      } catch (err: unknown) {
        console.warn('TREK Places autocomplete failed, falling back:', (err as Error).message);
      }
    }

    if (!apiKey) {
      return this.autocompleteNominatim(input, lang);
    }

    const body: Record<string, unknown> = {
      input,
      languageCode: toApiLang(lang),
    };
    // With a session token Google bills the whole search as one autocomplete
    // session instead of charging each keystroke; the details call that closes
    // the session carries the same token.
    if (sessionToken) body.sessionToken = sessionToken;
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

    const data = (await response.json()) as {
      suggestions?: GoogleAutocompleteSuggestion[];
      error?: { message?: string };
    };

    if (!response.ok) {
      logKeyFailure('autocomplete', response.status, userId, keySource);
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

  private async autocompleteNominatim(
    input: string,
    lang?: string,
  ): Promise<{ suggestions: { placeId: string; mainText: string; secondaryText: string }[]; source: string }> {
    try {
      const places = await this.searchNominatim(input, lang);
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

  // ── Place details (Google or OSM) ──────────────────────────────────────────

  async getPlaceDetails(
    userId: number,
    placeId: string,
    lang?: string,
    sessionToken?: string,
  ): Promise<{ place: Record<string, unknown> | null }> {
    // A place picked out of the TREK index. Checked BEFORE the generic
    // colon branch below, which would otherwise read "gers" as an OSM type
    // and ask Overpass for an element that does not exist.
    if (placeId.startsWith('gers:')) {
      const found = await trekPlacesById(placeId.slice('gers:'.length)).catch(() => null);
      if (!found) return { place: null };

      // What the index does not have, the free sources still do: cuisine,
      // wheelchair access, a menu link. OpenStreetMap has all of them for the
      // same building, and without this the details a user saw while adding the
      // place disappeared from its card afterwards, which reads like data loss.
      //
      // Matched by name and coordinate, with the same two gates
      // resolveOsmIdentity applies everywhere: within range, and sharing a
      // substantial word of the name. A confident description of the building
      // next door is worse than none.
      const osm = await this.resolveOsmIdentity(found.name, found.lat, found.lng, {
        lang,
        maxDistanceM: 150,
      }).catch(() => null);

      const record = toPlaceRecord(found);
      // Hours the index read off the operator's own site, run through the same
      // expansion OSM's go through — the client reads a list of weekday lines,
      // not the raw syntax, and handing it two shapes for one field would be a
      // bug on every card that shows it.
      //
      // Measured across seven countries, OpenStreetMap has hours for 27.5
      // percent of gastronomy; this covers part of the rest. It is the
      // fallback, not the first choice: an OSM entry describes this exact
      // object and gets corrected by people who walked past, where a chain's
      // website often carries one set of hours for every branch.
      const fromSite =
        typeof found.hours?.osm === 'string' ? buildOsmDetails({ opening_hours: found.hours.osm }, '', '') : null;
      if (!osm) {
        return {
          place: fromSite?.opening_hours
            ? {
                ...record,
                opening_hours: fromSite.opening_hours,
                open_now: fromSite.open_now,
                opening_periods: fromSite.opening_periods,
              }
            : record,
        };
      }

      const osmDetails = buildOsmDetails(osm.tags, '', '');
      const hoursFrom = osmDetails.opening_hours ? osmDetails : fromSite;
      return {
        place: {
          // Index first: its name, coordinate and contact details are the ones
          // the user picked. OSM only fills what is still missing.
          ...osmDetails,
          ...record,
          opening_hours: hoursFrom?.opening_hours ?? null,
          open_now: hoursFrom?.open_now ?? null,
          opening_periods: hoursFrom?.opening_periods ?? null,
          website: record.website ?? osmDetails.website ?? null,
          phone: record.phone ?? osmDetails.phone ?? null,
          osm_id: placeId,
          source: 'trek-places',
        },
      };
    }

    // OSM details: placeId is "node:123456" or "way:123456" etc.
    if (placeId.includes(':')) {
      const [osmType, osmId] = placeId.split(':');
      // buildOsmDetails never yields name/address/coordinates — Nominatim is
      // always the source for those (Overpass contributes the tag-derived rest).
      const [element, nominatim] = await Promise.all([
        this.fetchOverpassDetails(osmType, osmId),
        this.lookupNominatim(osmType, osmId, lang),
      ]);
      // Overpass has the fuller tag set and wins where both answer, but it is
      // also the one that goes down — overpass-api.de is regularly overloaded.
      // Nominatim's extratags carry the wikidata/wikipedia/commons tags too, so
      // a place keeps its pictures and its description when Overpass times out
      // instead of falling back to "photographed within 300m".
      const details = buildOsmDetails(
        { ...(nominatim?.extratags ?? {}), ...(element?.tags ?? {}) },
        osmType,
        osmId,
      );

      return {
        place: {
          ...details,
          name: nominatim?.name || element?.tags?.name || '',
          address: nominatim?.address || '',
          lat: nominatim?.lat ?? null,
          lng: nominatim?.lng ?? null,
          osm_id: placeId,
        },
      };
    }

    // Google details
    // 'en' default, aligned with search/autocomplete and the MCP tools' ?? 'en'
    // (the 'de' the legacy service defaulted to was a development leftover;
    // cache rows keyed 'de' for lang-less callers go cold once — 7-day TTL).
    const langKey = toApiLang(lang);
    const apiKey = this.getMapsKey(userId);
    // No key means no way to resolve a Google id: they have no OpenStreetMap
    // equivalent to fall back to. That is an empty result, not a client error.
    // Search and autocomplete already answer their keyless case with the OSM
    // stack; this used to be the one place that threw instead, which turned an
    // instance without a key into a stream of 400s whenever an older Google
    // place was opened. Callers already treat a null place as a miss.
    if (!apiKey) return { place: null };

    // Check DB cache first (lean mask, expanded=0) — 7-day TTL
    const DETAILS_TTL = 7 * 24 * 60 * 60 * 1000;
    const cached = this.database.get<{ payload_json: string; fetched_at: number }>(
      'SELECT payload_json, fetched_at FROM place_details_cache WHERE place_id = ? AND lang = ? AND expanded = 0',
      placeId,
      langKey,
    );
    if (cached && Date.now() - cached.fetched_at < DETAILS_TTL) return { place: JSON.parse(cached.payload_json) };

    // Closes the autocomplete session this lookup belongs to, so Google bills
    // the search once instead of per keystroke. A cache hit above never reaches
    // here, which is billing-neutral: an unclosed session is charged as a plain
    // autocomplete session.
    const sessionParam = sessionToken ? `&sessionToken=${encodeURIComponent(sessionToken)}` : '';
    const response = await googleFetch(
      `https://places.googleapis.com/v1/places/${placeId}?languageCode=${langKey}${sessionParam}`,
      `getPlaceDetails(${placeId})`,
      {
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'id,displayName,formattedAddress,location,rating,userRatingCount,websiteUri,nationalPhoneNumber,regularOpeningHours,googleMapsUri',
        },
      },
    );

    const data = (await response.json()) as GooglePlaceDetails & { error?: { message?: string } };

    if (!response.ok) {
      const err = new Error(data.error?.message || 'Google Places API error') as Error & { status: number };
      err.status = response.status;
      throw err;
    }

    const place = {
      google_place_id: data.id,
      google_ftid: googleFtidFromMapsUrl(data.googleMapsUri),
      name: data.displayName?.text || '',
      address: data.formattedAddress || '',
      // `?? null`, not `|| null`: 0 is a real coordinate (equator / prime meridian).
      lat: data.location?.latitude ?? null,
      lng: data.location?.longitude ?? null,
      rating: data.rating || null,
      rating_count: data.userRatingCount || null,
      website: data.websiteUri || null,
      phone: data.nationalPhoneNumber || null,
      opening_hours: data.regularOpeningHours?.weekdayDescriptions || null,
      open_now: data.regularOpeningHours?.openNow ?? null,
      // open_now is a snapshot Google took when this payload was fetched and it is cached
      // for days; the periods let the client recompute the state in the place's own
      // timezone, which the localised weekday lines above cannot do. Issue #1680.
      opening_periods: normalizeOpeningPeriods(data.regularOpeningHours?.periods),
      opening_special_days: normalizeSpecialDays(data.regularOpeningHours?.specialDays),
      google_maps_url: data.googleMapsUri || null,
      summary: null,
      reviews: [],
      source: 'google' as const,
      cached_at: Date.now(),
    };

    try {
      this.database.run(
        'INSERT OR REPLACE INTO place_details_cache (place_id, lang, expanded, payload_json, fetched_at) VALUES (?, ?, 0, ?, ?)',
        placeId,
        langKey,
        JSON.stringify(place),
        Date.now(),
      );
    } catch (dbErr) {
      console.error('Failed to cache place details:', dbErr);
    }

    return { place };
  }

  async getPlaceDetailsExpanded(
    userId: number,
    placeId: string,
    lang?: string,
    refresh = false,
  ): Promise<{ place: Record<string, unknown> | null }> {
    // Reviews and the editorial summary only exist at Google, but the id does not
    // have to be a Google one — the client sends whatever the place carries. OSM ids
    // keep the details they do have (Overpass, via the plain lookup); coordinate
    // pseudo-ids and legacy image URLs have no details source at all. Neither may be
    // forwarded to Google, which bills the 400 INVALID_ARGUMENT it answers with.
    if (!isGooglePlaceId(placeId)) {
      return OSM_PLACE_ID.test(placeId) ? this.getPlaceDetails(userId, placeId, lang) : { place: null };
    }

    const langKey = toApiLang(lang); // 'en' default — see getPlaceDetails
    const apiKey = this.getMapsKey(userId);
    // Same as the lean lookup above: an empty result, not a client error.
    if (!apiKey) return { place: null };

    // Check DB cache for expanded result
    if (!refresh) {
      const cached = this.database.get<{ payload_json: string }>(
        'SELECT payload_json FROM place_details_cache WHERE place_id = ? AND lang = ? AND expanded = 1',
        placeId,
        langKey,
      );
      if (cached) return { place: JSON.parse(cached.payload_json) };
    }

    const response = await googleFetch(
      `https://places.googleapis.com/v1/places/${placeId}?languageCode=${langKey}`,
      `getPlaceDetailsExpanded(${placeId})`,
      {
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'id,displayName,formattedAddress,location,rating,userRatingCount,websiteUri,nationalPhoneNumber,regularOpeningHours,googleMapsUri,reviews,editorialSummary',
        },
      },
    );

    const data = (await response.json()) as GooglePlaceDetails & { error?: { message?: string } };

    if (!response.ok) {
      const err = new Error(data.error?.message || 'Google Places API error') as Error & { status: number };
      err.status = response.status;
      throw err;
    }

    const place = {
      google_place_id: data.id,
      google_ftid: googleFtidFromMapsUrl(data.googleMapsUri),
      name: data.displayName?.text || '',
      address: data.formattedAddress || '',
      // `?? null`, not `|| null`: 0 is a real coordinate (equator / prime meridian).
      lat: data.location?.latitude ?? null,
      lng: data.location?.longitude ?? null,
      rating: data.rating || null,
      rating_count: data.userRatingCount || null,
      website: data.websiteUri || null,
      phone: data.nationalPhoneNumber || null,
      opening_hours: data.regularOpeningHours?.weekdayDescriptions || null,
      open_now: data.regularOpeningHours?.openNow ?? null,
      opening_periods: normalizeOpeningPeriods(data.regularOpeningHours?.periods),
      opening_special_days: normalizeSpecialDays(data.regularOpeningHours?.specialDays),
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
      this.database.run(
        'INSERT OR REPLACE INTO place_details_cache (place_id, lang, expanded, payload_json, fetched_at) VALUES (?, ?, 1, ?, ?)',
        placeId,
        langKey,
        JSON.stringify(place),
        Date.now(),
      );
    } catch (dbErr) {
      console.error('Failed to cache expanded place details:', dbErr);
    }

    return { place };
  }

  // ── Place photo (Google or Wikimedia, disk-cached) ─────────────────────────

  async getPlacePhoto(
    userId: number,
    placeId: string,
    lat: number,
    lng: number,
    name?: string,
  ): Promise<{ photoUrl: string | null; attribution: string | null }> {
    // Disk cache hit — serve immediately, no Google call
    const diskHit = await this.photoCache.get(placeId);
    if (diskHit) return { photoUrl: diskHit.photoUrl, attribution: diskHit.attribution };

    // "No photo for this place" is an empty result, not a missing resource: a trip
    // view asks for one photo per place, so answering each miss with a 404 makes a
    // normal itinerary render look like a 404 scan to fail2ban/CrowdSec and gets
    // the user's IP banned. Every miss below returns photoUrl: null instead — the
    // same shape the photos kill-switch already returns.
    const noPhoto = { photoUrl: null, attribution: null };

    // Recent miss — don't hammer the API
    if (this.photoCache.getErrored(placeId)) return noPhoto;

    // Deduplicate concurrent requests for the same placeId
    const existing = this.photoCache.getInFlight(placeId);
    if (existing !== undefined) {
      const result = await existing;
      if (!result) return noPhoto;
      return { photoUrl: `/api/maps/place-photo/${encodeURIComponent(placeId)}/bytes`, attribution: result.attribution };
    }

    // Tells the two empty outcomes apart for the negative cache below: a place that
    // has no photo anywhere is worth remembering for a day, a provider that refused
    // or timed out only for a few minutes.
    let providerFailed = false;

    const fetchPromise = (async (): Promise<{ attribution: string | null } | null> => {
      await acquirePhotoFetchSlot();
      try {
        const apiKey = this.getMapsKey(userId);

        // Coordinate-based Wikipedia/Wikimedia lookup. Used for coordinate-only
        // (right-click) places and as a fallback when a Google place yields no photo,
        // so a place added via search still gets a marker image when Google returns
        // nothing. Returns null (without marking an error) so the caller decides.
        const fetchWikimediaFallback = async (): Promise<{ attribution: string | null } | null> => {
          if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
          try {
            const wiki = await this.fetchWikimediaPhoto(lat, lng, name);
            if (!wiki) return null;
            // Follow redirects manually so each hop (the image URL can 3xx to a CDN
            // host) is re-validated against the SSRF guard, not just the first URL.
            const imgRes = await safeFetchFollow(wiki.photoUrl, undefined, { bypassInternalIpAllowed: true });
            if (!imgRes.ok) {
              providerFailed = true;
              return null;
            }
            const bytes = Buffer.from(await imgRes.arrayBuffer());
            const cached = await this.photoCache.put(placeId, bytes, wiki.attribution);
            return { attribution: cached.attribution };
          } catch {
            providerFailed = true;
            return null;
          }
        };

        // Google Places photo for a Google place_id. Returns null on any miss — no
        // key, request rejected, no photos, or a failed media download — so the
        // caller can fall back to Wikimedia; the misses that were Google's fault
        // flag providerFailed on the way out.
        const fetchGooglePhoto = async (): Promise<{ attribution: string | null } | null> => {
          if (!apiKey) return null;

          // Fetch details to get the photo name
          const detailsRes = await googleFetch(
            `https://places.googleapis.com/v1/places/${placeId}`,
            `getPlacePhoto/details(${placeId})`,
            {
              headers: {
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': 'photos',
              },
            },
          );
          const body = await detailsRes.text();
          if (!detailsRes.ok) {
            console.error('Google Places photo details error:', detailsRes.status, body.slice(0, 200));
            providerFailed = true;
            return null;
          }
          let details: GooglePlaceDetails & { error?: { message?: string } };
          try {
            details = body ? JSON.parse(body) : { photos: [] };
          } catch {
            providerFailed = true;
            return null;
          }
          if (!details.photos?.length) return null;

          const photo = details.photos[0];
          const photoName = photo.name;
          const attribution = photo.authorAttributions?.[0]?.displayName || null;

          // Fetch actual image bytes
          const mediaRes = await googleFetch(
            `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=400`,
            `getPlacePhoto/media(${placeId})`,
            { headers: { 'X-Goog-Api-Key': apiKey } },
          );
          // The place does have a photo — only the download for it went wrong.
          if (!mediaRes.ok) {
            providerFailed = true;
            return null;
          }

          const bytes = Buffer.from(await mediaRes.arrayBuffer());
          if (!bytes.length) {
            providerFailed = true;
            return null;
          }

          const cached = await this.photoCache.put(placeId, bytes, attribution);

          // Persist stable proxy URL to database
          try {
            this.database.run(
              "UPDATE places SET image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE google_place_id = ? AND (image_url IS NULL OR image_url = '')",
              cached.photoUrl,
              placeId,
            );
          } catch (dbErr) {
            console.error('Failed to persist photo URL to database:', dbErr);
          }

          return { attribution };
        };

        // Prefer the Google photo (higher quality); if Google yields nothing, fall
        // back to the same coordinate-based Wikipedia/OSM lookup that right-click
        // places use. Ids Google cannot resolve skip it entirely.
        if (isGooglePlaceId(placeId)) {
          const googlePhoto = await fetchGooglePhoto();
          if (googlePhoto) return googlePhoto;
        }

        const fallback = await fetchWikimediaFallback();
        if (fallback) return fallback;

        this.photoCache.markError(placeId, providerFailed ? 'provider-error' : 'no-photo');
        return null;
      } finally {
        releasePhotoFetchSlot();
      }
    })();

    this.photoCache.setInFlight(placeId, fetchPromise);

    const result = await fetchPromise;
    if (!result) return noPhoto;
    return { photoUrl: `/api/maps/place-photo/${encodeURIComponent(placeId)}/bytes`, attribution: result.attribution };
  }

  // ── Reverse geocoding ──────────────────────────────────────────────────────

  async reverseGeocode(
    lat: string,
    lng: string,
    lang?: string,
    opts?: { lane?: GeoLane; timeoutMs?: number },
  ): Promise<{ name: string | null; address: string | null }> {
    const params = new URLSearchParams({
      lat,
      lon: lng,
      format: 'json',
      addressdetails: '1',
      zoom: '18',
      'accept-language': toApiLang(lang),
    });
    const response = await nominatimFetch('reverse', params, opts);
    if (!response.ok) return { name: null, address: null };
    const data = (await response.json()) as { name?: string; display_name?: string; address?: Record<string, string> };
    const addr = data.address || {};
    const name = data.name || addr.tourism || addr.amenity || addr.shop || addr.building || addr.road || null;
    return { name, address: data.display_name || null };
  }

  // ── Resolve Google Maps URL ────────────────────────────────────────────────

  async resolveGoogleMapsUrl(
    url: string,
  ): Promise<{ lat: number; lng: number; name: string | null; address: string | null; google_ftid: string | null }> {
    let resolvedUrl = url;

    // Extract coordinates from a string (URL or page body). Google Maps encodes
    // them several ways: /@lat,lng,zoom · !3dlat!4dlng (map data param) · ?q=/?ll=.
    const extractCoords = (s: string): { lat: number; lng: number } | null => {
      const at = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (at) return { lat: Number.parseFloat(at[1]), lng: Number.parseFloat(at[2]) };
      const data = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
      if (data) return { lat: Number.parseFloat(data[1]), lng: Number.parseFloat(data[2]) };
      const q = s.match(/[?&](?:q|ll)=(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (q) return { lat: Number.parseFloat(q[1]), lng: Number.parseFloat(q[2]) };
      return null;
    };

    const followRedirects = async (target: string, init?: RequestInit): Promise<Response> => {
      try {
        return await safeFetchFollow(
          target,
          { signal: AbortSignal.timeout(10000), ...init },
          { bypassInternalIpAllowed: true },
        );
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          throw Object.assign(new Error('URL blocked by SSRF check'), { status: 403 });
        }
        throw err;
      }
    };

    // Follow redirects for short URLs (goo.gl, maps.app.goo.gl) and for Google Maps
    // URLs that carry no inline coordinates — e.g. ?cid= links (the format
    // get_place_details returns) and "Share"-button links. The redirect target
    // usually carries the !3d!4d data param we can then parse. Redirects are
    // followed manually so every hop is SSRF-re-checked.
    const parsed = new URL(url);
    const isShort = GOOGLE_SHORT_HOSTS.includes(parsed.hostname);
    const isGoogleMaps = isGoogleMapsHost(parsed.hostname);
    if (isShort || (isGoogleMaps && !extractCoords(url))) {
      resolvedUrl = (await followRedirects(url)).url || resolvedUrl;
    }

    let coords = extractCoords(resolvedUrl);

    // Still nothing (e.g. a cid page whose final URL lacks coordinates): fetch the
    // page body once and parse the coordinates out of the embedded map data.
    // Only Google's own pages get read; the resolved host is what counts, so a
    // short link that lands on maps.google.com still qualifies.
    let resolvedHost = '';
    try { resolvedHost = new URL(resolvedUrl).hostname; } catch { /* keep the empty host, the branch is skipped */ }
    if (!coords && isGoogleMapsHost(resolvedHost)) {
      try {
        const pageRes = await followRedirects(resolvedUrl, {
          headers: { 'User-Agent': UA },
        });
        if (exceedsDeclaredLength(pageRes, MAX_MAPS_PAGE_BYTES)) {
          // Nothing here will read it, and an unread body keeps its socket.
          discardBody(pageRes);
        } else {
          // The map data sits near the top of the document, so a truncated read
          // still finds the coordinates; an oversized page degrades to the same
          // 400 an unparseable one already produced.
          const { text } = await readCappedText(pageRes, MAX_MAPS_PAGE_BYTES);
          coords = extractCoords(text);
        }
      } catch (err) {
        if ((err as { status?: number })?.status === 403) throw err; // SSRF block, surface it
        // Otherwise fall through to the not-found error below.
      }
    }

    // Extract place name from URL path: /place/Place+Name/@...
    let placeName: string | null = null;
    const placeMatch = resolvedUrl.match(/\/place\/([^/@]+)/);
    if (placeMatch) {
      placeName = decodeURIComponent(placeMatch[1].replaceAll(/\+/g, ' '));
    }

    if (!coords || Number.isNaN(coords.lat) || Number.isNaN(coords.lng)) {
      throw Object.assign(new Error('Could not extract coordinates from URL'), { status: 400 });
    }
    const { lat, lng } = coords;

    // Reverse geocode to get address. A non-ok answer (Nominatim 5xx/429) must
    // not fail the whole resolution — the coordinates are already extracted, so
    // fall back to the URL-derived name and a null address.
    const nominatimRes = await nominatimFetch(
      'reverse',
      new URLSearchParams({ lat: String(lat), lon: String(lng), format: 'json', addressdetails: '1' }),
      { timeoutMs: 8000 },
    );
    const nominatim: { display_name?: string; name?: string; address?: Record<string, string> } = nominatimRes.ok
      ? await nominatimRes.json()
      : {};

    const name = placeName || nominatim.name || nominatim.address?.tourism || nominatim.address?.building || null;
    const address = nominatim.display_name || null;

    return { lat, lng, name, address, google_ftid: googleFtidFromMapsUrl(resolvedUrl) };
  }
}
