/**
 * Google Places (v1) as a PlacesProvider.
 *
 * Every line here was lifted out of maps.service.ts when the provider seam went
 * in, deliberately without behaviour changes: same endpoints, same field masks,
 * same error shape (an `Error` carrying `.status`), same call counter and the
 * same `PLACES_API_BASE` substitution. The existing MAPS-* unit tests are the
 * proof of that, so if you change something here, expect them to say so.
 *
 * The class is constructed per request over a resolved credential rather than
 * injected: the credential differs per caller (operator env / instance / the
 * user's own row) and carrying it in a field is what lets a 403 name its source
 * without the key ever reaching a log line.
 */
import { getAppUrl, readEnv } from '../../../app-config';
import {
  SEARCH_TEXT_FIELD_MASK,
  googleFtidFromMapsUrl,
  isGooglePlaceId,
  normalizeOpeningPeriods,
  normalizeSpecialDays,
  toApiLang,
  type GoogleOpeningHours,
} from '../maps.helpers';
import type {
  DetailsOptions,
  PlacesProvider,
  ProviderCredential,
  ProviderPhotoRef,
  ProviderPlace,
  ProviderSuggestion,
  SearchBias,
  ViewportBias,
} from './places-provider';
import type { ApiKeySource } from '../../settings/instance-api-keys';

// ── Wire shapes ──────────────────────────────────────────────────────────────

export interface GooglePlaceResult {
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

export interface GooglePlaceDetails extends GooglePlaceResult {
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

/** The lean mask, and the expanded one that adds what only Google has. */
const DETAILS_FIELD_MASK =
  'id,displayName,formattedAddress,location,rating,userRatingCount,websiteUri,nationalPhoneNumber,regularOpeningHours,googleMapsUri';
const DETAILS_FIELD_MASK_EXPANDED = `${DETAILS_FIELD_MASK},reviews,editorialSummary`;

// ── Outbound plumbing ────────────────────────────────────────────────────────

let googleApiCallCount = 0;

/** Ceiling for one Google Places call. Generous — the photo download is the slow one. */
const GOOGLE_FETCH_TIMEOUT_MS = 20000;

/** The upstream every Places call is written against. */
const PLACES_UPSTREAM = 'https://places.googleapis.com';

/**
 * Sends the call somewhere else when PLACES_API_BASE is set.
 *
 * The Places endpoints below all spell out the upstream host, so an install that
 * wants these calls to leave through something of its own — an egress proxy, a
 * cache, a gateway holding the key — has no way to say so today. One variable,
 * substituted at the one place every call funnels through.
 *
 * Path and query are untouched, so the replacement has to speak the same API.
 * Unset, which is every install today, the string is returned as it came in.
 */
export function placesEndpoint(endpoint: string): string {
  const base = readEnv().maps.placesApiBase;
  if (!base || !endpoint.startsWith(PLACES_UPSTREAM)) return endpoint;
  // The character before the run is matched and written straight back. A bare
  // /\/+$/ restarts at every slash of a base that does not end in one, reading
  // the rest of the run again from each of them.
  return base.replace(/([^/]|^)\/+$/, '$1') + endpoint.slice(PLACES_UPSTREAM.length);
}

export function googleFetch(rawEndpoint: string, label: string, init?: RequestInit): Promise<Response> {
  const endpoint = placesEndpoint(rawEndpoint);
  googleApiCallCount++;
  console.debug(`[Google API] #${googleApiCallCount} ${label} → ${endpoint}`);
  const referer = readEnv().app.appUrl ? getAppUrl() : undefined;
  return fetch(endpoint, {
    ...init,
    // A default ceiling here rather than at each of the nine call sites, none of
    // which passed one: a hung upstream held the request handler open for as
    // long as it liked. A caller that needs longer still wins, it only has to
    // say so.
    signal: init?.signal ?? AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    headers: { ...(referer ? { Referer: referer } : {}), ...((init?.headers as Record<string, string>) ?? {}) },
  });
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

// ── Provider ─────────────────────────────────────────────────────────────────

export class GooglePlacesProvider implements PlacesProvider {
  readonly id = 'google' as const;

  constructor(private readonly credential: ProviderCredential) {}

  /** The language Google should answer in. 'en' when the caller said nothing. */
  private lang(lang?: string): string {
    return toApiLang(lang);
  }

  private headers(fieldMask?: string): Record<string, string> {
    return {
      'X-Goog-Api-Key': this.credential.key,
      ...(fieldMask ? { 'X-Goog-FieldMask': fieldMask } : {}),
    };
  }

  ownsPlaceId(placeId: string): boolean {
    return isGooglePlaceId(placeId);
  }

  async searchText(query: string, lang?: string, bias?: SearchBias): Promise<ProviderPlace[]> {
    const searchBody: Record<string, unknown> = { textQuery: query, languageCode: this.lang(lang) };
    // Bias results toward the caller's area when supplied — without it Google Text
    // Search falls back to the API key's billing region, which skews foreign-region queries.
    if (bias) {
      searchBody.locationBias = {
        circle: {
          center: { latitude: bias.lat, longitude: bias.lng },
          radius: bias.radius ?? 50000,
        },
      };
    }

    const response = await googleFetch('https://places.googleapis.com/v1/places:searchText', 'searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers(SEARCH_TEXT_FIELD_MASK) },
      body: JSON.stringify(searchBody),
    });

    const data = (await response.json()) as { places?: GooglePlaceResult[]; error?: { message?: string } };

    if (!response.ok) {
      this.fail('searchText', response.status, data.error?.message, 'Google Places API error');
    }

    // A place that has shut down for good is never the answer to "where should we
    // go" (#1341). Temporarily closed stays: a restaurant on holiday next month is
    // still worth planning around. Anything without the field is a non-business
    // result (a park, a viewpoint) and is kept.
    return (data.places || [])
      .filter((p) => p.businessStatus !== 'CLOSED_PERMANENTLY')
      .map((p) => ({
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
  }

  async autocomplete(
    input: string,
    lang?: string,
    bias?: ViewportBias,
    sessionToken?: string,
  ): Promise<ProviderSuggestion[]> {
    const body: Record<string, unknown> = { input, languageCode: this.lang(lang) };
    // With a session token Google bills the whole search as one autocomplete
    // session instead of charging each keystroke; the details call that closes
    // the session carries the same token.
    if (sessionToken) body.sessionToken = sessionToken;
    if (bias) {
      body.locationBias = {
        rectangle: {
          low: { latitude: bias.low.lat, longitude: bias.low.lng },
          high: { latitude: bias.high.lat, longitude: bias.high.lng },
        },
      };
    }

    const response = await googleFetch('https://places.googleapis.com/v1/places:autocomplete', 'autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.credential.key },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as {
      suggestions?: GoogleAutocompleteSuggestion[];
      error?: { message?: string };
    };

    if (!response.ok) {
      this.fail('autocomplete', response.status, data.error?.message, 'Google Places Autocomplete error');
    }

    return (data.suggestions || [])
      .filter((s) => s.placePrediction)
      .slice(0, 5)
      .map((s) => ({
        placeId: s.placePrediction!.placeId,
        mainText: s.placePrediction!.structuredFormat?.mainText?.text || '',
        secondaryText: s.placePrediction!.structuredFormat?.secondaryText?.text || '',
      }));
  }

  async placeDetails(placeId: string, opts: DetailsOptions = {}): Promise<ProviderPlace | null> {
    const langKey = this.lang(opts.lang);
    const expanded = opts.expanded === true;
    // Closes the autocomplete session this lookup belongs to, so Google bills
    // the search once instead of per keystroke.
    const sessionParam = opts.sessionToken ? `&sessionToken=${encodeURIComponent(opts.sessionToken)}` : '';

    const response = await googleFetch(
      `https://places.googleapis.com/v1/places/${placeId}?languageCode=${langKey}${sessionParam}`,
      expanded ? `getPlaceDetailsExpanded(${placeId})` : `getPlaceDetails(${placeId})`,
      {
        method: 'GET',
        headers: this.headers(expanded ? DETAILS_FIELD_MASK_EXPANDED : DETAILS_FIELD_MASK),
      },
    );

    const data = (await response.json()) as GooglePlaceDetails & { error?: { message?: string } };

    if (!response.ok) {
      // No logKeyFailure here, matching the pre-seam behaviour: the details pair
      // threw bare. Adding a log line would be an improvement, but not a silent one.
      const err = new Error(data.error?.message || 'Google Places API error') as Error & { status: number };
      err.status = response.status;
      throw err;
    }

    return {
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
      summary: expanded ? data.editorialSummary?.text || null : null,
      reviews: expanded
        ? (data.reviews || []).slice(0, 5).map((r) => ({
            author: r.authorAttribution?.displayName || null,
            rating: r.rating || null,
            text: r.text?.text || null,
            time: r.relativePublishTimeDescription || null,
            photo: r.authorAttribution?.photoUri || null,
          }))
        : [],
      source: 'google' as const,
      cached_at: Date.now(),
    };
  }

  async photoRefs(placeId: string, cap: number): Promise<ProviderPhotoRef[]> {
    if (!this.ownsPlaceId(placeId) || cap < 1) return [];
    try {
      const res = await googleFetch(
        `https://places.googleapis.com/v1/places/${placeId}`,
        `fetchGooglePhotoRefs(${placeId})`,
        { headers: this.headers('photos') },
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
  async photoBytes(photoName: string, maxHeightPx = 400): Promise<Buffer | null> {
    try {
      const res = await googleFetch(
        `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=${maxHeightPx}`,
        `fetchGooglePhotoBytes(${photoName})`,
        { headers: { 'X-Goog-Api-Key': this.credential.key } },
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
   * placeDetails({ expanded: true }) would also return this, but its field mask
   * includes `reviews`, which moves the call into the Enterprise SKU. Enrichment
   * only wants the sentence, so it asks for the sentence.
   */
  async editorialSummary(placeId: string, lang?: string): Promise<string | null> {
    if (!this.ownsPlaceId(placeId)) return null;
    try {
      const res = await googleFetch(
        `https://places.googleapis.com/v1/places/${placeId}?languageCode=${this.lang(lang)}`,
        `fetchEditorialSummary(${placeId})`,
        { headers: this.headers('editorialSummary') },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as GooglePlaceDetails;
      return data.editorialSummary?.text?.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * The two paths that log their key source before throwing. `never` return so
   * the caller does not need a redundant `throw`/`return` after it.
   */
  private fail(label: string, status: number, message: string | undefined, fallback: string): never {
    logKeyFailure(label, status, this.credential.userId, this.credential.source);
    const err = new Error(message || fallback) as Error & { status: number };
    err.status = status;
    throw err;
  }

  /**
   * The single Google photo the marker path wants, bytes included.
   *
   * `failed` separates "this place has no picture" from "Google would not give
   * us one": the caller caches the former for a day and the latter for minutes.
   */
  async firstPhotoBytes(
    placeId: string,
  ): Promise<{ bytes: Buffer | null; attribution: string | null; failed: boolean }> {
    // Fetch details to get the photo name.
    const detailsRes = await googleFetch(
      `https://places.googleapis.com/v1/places/${placeId}`,
      `getPlacePhoto/details(${placeId})`,
      { headers: this.headers('photos') },
    );
    const body = await detailsRes.text();
    if (!detailsRes.ok) {
      console.error('Google Places photo details error:', detailsRes.status, body.slice(0, 200));
      return { bytes: null, attribution: null, failed: true };
    }
    let details: GooglePlaceDetails;
    try {
      details = body ? (JSON.parse(body) as GooglePlaceDetails) : ({ photos: [] } as unknown as GooglePlaceDetails);
    } catch {
      return { bytes: null, attribution: null, failed: true };
    }
    // No photo at all is not a provider failure — the caller falls through to
    // Wikimedia and, failing that, caches a day-long "no photo".
    if (!details.photos?.length) return { bytes: null, attribution: null, failed: false };

    const photo = details.photos[0];
    const attribution = photo.authorAttributions?.[0]?.displayName || null;

    const bytes = await this.photoBytes(photo.name);
    // The place does have a photo — only the download for it went wrong.
    if (!bytes) return { bytes: null, attribution: null, failed: true };
    return { bytes, attribution, failed: false };
  }
}

