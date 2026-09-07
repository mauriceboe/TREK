/**
 * Amap (高德地图) Web Service API as a PlacesProvider.
 *
 * Why this exists: Google Places and Nominatim are both poor inside mainland
 * China. Google is unreachable from most Chinese networks, and OpenStreetMap's
 * coverage of Chinese POIs — restaurants, shops, the things a trip is actually
 * made of — is thin and rarely in Chinese. Amap is what a Chinese user expects
 * their map search to behave like.
 *
 * Two things make this provider different from the Google one:
 *
 *  1. **Datum.** Amap speaks GCJ-02, TREK speaks WGS-84 everywhere else. This
 *     file is one of the two places in the codebase allowed to hold a GCJ-02
 *     coordinate, and it never lets one escape: every outbound coordinate is
 *     converted on the way out, every inbound one on the way back. Nothing
 *     downstream — the database, the map, a GPX export — ever sees GCJ-02.
 *
 *  2. **Errors.** Amap answers HTTP 200 for everything and puts the verdict in
 *     the body (`status: "0"` plus an `infocode`). A quota-exceeded response and
 *     a successful one are the same status line, so the body is checked and
 *     translated into the same `Error & { status }` the Google path throws —
 *     otherwise the controller's error mapping would report every failure as an
 *     empty result.
 *
 * Deliberately not implemented: `photoRefs`/`photoBytes`. Amap's POI photos come
 * with no licence statement we could show a user, and the existing Wikimedia
 * fallback already produces a picture *with* its attribution. An unattributable
 * image is worse than no image, so the photo path falls through to Wikimedia for
 * Amap places.
 */
import { createHash } from 'node:crypto';
import { fromAmapLocation, gcj02ToWgs84, toAmapLocation } from '@trek/shared';
import { readEnv } from '../../../app-config';
import { safeFetchFollow } from '../../../utils/ssrfGuard';
import { UA, parseOpeningHours } from '../maps.helpers';
import type {
  DetailsOptions,
  PlacesProvider,
  ProviderCredential,
  ProviderPlace,
  ProviderSuggestion,
  SearchBias,
  ViewportBias,
} from './places-provider';

/** The upstream every Web Service call is written against. */
const AMAP_UPSTREAM = 'https://restapi.amap.com';

/**
 * The prefix that makes an Amap POI id recognisable anywhere in TREK.
 *
 * Amap ids are bare hex-ish strings (`B0FFFAB6J2`), indistinguishable from a
 * Google place id by shape. Without a namespace, an Amap place opened later
 * would be sent to Google, which answers a foreign id with a *billable* 400.
 * The separator is a colon to match the existing `node:`/`way:`/`coords:`
 * convention — see maps.helpers.ts, where this prefix is part of
 * NON_GOOGLE_PLACE_ID for exactly that reason.
 */
export const AMAP_PLACE_ID_PREFIX = 'amap:';
export const AMAP_PLACE_ID = /^amap:(.+)$/i;

export function isAmapPlaceId(placeId: string): boolean {
  return AMAP_PLACE_ID.test(placeId);
}

/** The bare provider id, or null when this is not an Amap place. */
export function amapPoiId(placeId: string): string | null {
  const m = AMAP_PLACE_ID.exec(placeId);
  return m ? m[1] : null;
}

let amapApiCallCount = 0;

/**
 * Amap accepts either `lang=zh_cn` or `lang=en`, and nothing else. Anything we
 * cannot serve is answered in Chinese rather than rejected, which is the right
 * default for a China-only provider.
 */
function toAmapLang(lang?: string): string {
  return lang && /^en/i.test(lang) ? 'en' : 'zh_cn';
}

/**
 * Amap's own error text for the codes an operator can actually act on.
 *
 * The raw `info` string is returned for everything else; these three are
 * singled out because they are the ones a misconfigured install hits first, and
 * because Amap's own wording for them ("INVALID_USER_SCODE") does not tell an
 * admin what to change.
 */
const AMAP_INFOCODE_HINTS: Record<string, string> = {
  '10001': 'Amap API key is invalid — check that it is a "Web 服务" (web service) key, not a JS API key',
  '10003': 'Amap daily request quota exhausted',
  '10009': 'Amap key rejected the request: the key is restricted to a different domain or IP',
};

/**
 * The HTTP status TREK should answer with for an Amap failure.
 *
 * Amap's own status line is always 200, and the controller maps a thrown
 * `.status` straight through to the client, so a credential problem has to
 * arrive as 403 and a quota problem as 429 for the client to say anything
 * useful about it.
 */
function statusForInfocode(infocode: string): number {
  if (infocode === '10001' || infocode === '10009') return 403;
  if (infocode === '10003' || infocode === '10004' || infocode === '10019' || infocode === '10020') return 429;
  return 502;
}

interface AmapEnvelope {
  status?: string;
  info?: string;
  infocode?: string;
}

interface AmapTip {
  id?: string;
  name?: string;
  district?: string;
  address?: unknown;
  location?: unknown;
}

interface AmapPoi {
  id?: string;
  name?: string;
  address?: unknown;
  location?: unknown;
  pname?: string;
  cityname?: string;
  adname?: string;
  type?: string;
  tel?: unknown;
  website?: unknown;
  biz_ext?: { rating?: unknown; open_time?: unknown };
  business?: { rating?: unknown; tel?: unknown; opentime_week?: unknown; opentime_today?: unknown };
}

/**
 * Amap returns an empty *array* where a string field has no value — `address:
 * []`, `tel: []` — so every optional text field has to be coerced rather than
 * read. A bare `poi.address || ''` yields `[]` in a template and `"[]"` in the
 * database.
 */
function amapText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  // Some fields arrive as a one-element array of the value.
  if (Array.isArray(value) && value.length === 1) return amapText(value[0]);
  return '';
}

function amapNumber(value: unknown): number | null {
  const text = amapText(value);
  if (!text) return null;
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n : null;
}

export class AmapPlacesProvider implements PlacesProvider {
  readonly id = 'amap' as const;

  constructor(private readonly credential: ProviderCredential) {}

  ownsPlaceId(placeId: string): boolean {
    return isAmapPlaceId(placeId);
  }

  // ── Outbound plumbing ──────────────────────────────────────────────────────

  /**
   * Build the full URL for one call, key and optional signature attached.
   *
   * `AMAP_API_BASE` mirrors `PLACES_API_BASE`: an install that routes its
   * outbound calls through a proxy or a gateway holding the credential says so
   * once, here.
   */
  private url(path: string, params: Record<string, string>): string {
    const query = new URLSearchParams({ ...params, key: this.credential.key, output: 'JSON' });
    const sig = this.signature(params);
    if (sig) query.set('sig', sig);
    const base = (readEnv().maps.amapApiBase || AMAP_UPSTREAM).replace(/([^/]|^)\/+$/, '$1');
    return `${base}${path}?${query.toString()}`;
  }

  /**
   * Amap's optional 数字签名 (digital signature).
   *
   * A key can be created with a private secret, and such a key rejects every
   * unsigned request. The scheme is an MD5 of the request parameters sorted by
   * name, with the secret appended — MD5 because Amap specifies MD5, not because
   * anything here is choosing a hash. The key itself is deliberately NOT part of
   * the signed set on the query-string form of the API.
   *
   * Unset, which is the common case, nothing is added.
   */
  private signature(params: Record<string, string>): string | null {
    const secret = readEnv().maps.amapApiSecret;
    if (!secret) return null;
    const signed = { ...params, key: this.credential.key, output: 'JSON' };
    const canonical = Object.keys(signed)
      .sort()
      .map((k) => `${k}=${signed[k]}`)
      .join('&');
    return createHash('md5').update(`${canonical}${secret}`).digest('hex');
  }

  /**
   * One call, with the body-carried verdict turned into a real error.
   *
   * Through safeFetchFollow like every other outbound URL in the maps domain, so
   * a proxied base cannot be pointed at something internal.
   */
  private async call<T extends AmapEnvelope>(path: string, params: Record<string, string>, label: string): Promise<T> {
    const url = this.url(path, params);
    amapApiCallCount++;
    // The key rides in the query string, so the label is logged without the URL —
    // unlike the Google path, where the credential sits in a header.
    console.debug(`[Amap API] #${amapApiCallCount} ${label} → ${path}`);

    const response = await safeFetchFollow(
      url,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) },
      { bypassInternalIpAllowed: true },
    );

    if (!response.ok) {
      // A transport-level failure, i.e. the proxy in front of Amap rather than
      // Amap itself: Amap's own answers are always 200.
      this.fail(label, response.status, `Amap ${label} failed with HTTP ${response.status}`);
    }

    const data = (await response.json()) as T;
    if (data.status !== '1') {
      const infocode = data.infocode ?? '';
      const hint = AMAP_INFOCODE_HINTS[infocode] || data.info || 'Amap API error';
      this.fail(label, statusForInfocode(infocode), `${hint} (infocode ${infocode || 'none'})`);
    }
    return data;
  }

  private fail(label: string, status: number, message: string): never {
    console.error(`[Maps] amap/${label} failed with ${status} userId=${this.credential.userId} keySource=${this.credential.source}`);
    const err = new Error(message) as Error & { status: number };
    err.status = status;
    throw err;
  }

  // ── Normalisation ──────────────────────────────────────────────────────────

  /**
   * One POI in the shape the rest of TREK consumes, coordinates back in WGS-84.
   *
   * `address` is assembled rather than taken as-is: Amap's `address` field is
   * the street line alone ("三里屯路19号"), which on its own is not enough to
   * tell two identically named branches apart in the place picker. Province,
   * city and district come as separate fields for exactly this purpose.
   */
  private toPlace(poi: AmapPoi): ProviderPlace | null {
    const coords = fromAmapLocation(poi.location);
    const business = poi.business ?? {};
    const bizExt = poi.biz_ext ?? {};
    const street = amapText(poi.address);
    const region = [amapText(poi.pname), amapText(poi.cityname), amapText(poi.adname)]
      // A municipality repeats itself — pname and cityname are both "北京市".
      .filter((part, i, all) => part && all.indexOf(part) === i);
    const address = [...region, street].filter(Boolean).join('');
    const openText = amapText(business.opentime_week) || amapText(bizExt.open_time);

    return {
      amap_poi_id: poi.id ? `${AMAP_PLACE_ID_PREFIX}${poi.id}` : null,
      name: amapText(poi.name),
      address,
      // Null rather than dropped: a POI with no geometry still answers "which
      // one did I mean" in the picker, and the caller decides whether it is
      // usable. `?? null` because 0 is a real coordinate.
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      rating: amapNumber(business.rating ?? bizExt.rating),
      rating_count: null,
      website: amapText(poi.website) || null,
      phone: amapText(business.tel ?? poi.tel) || null,
      // Amap's type is a slash-separated taxonomy ("餐饮服务;中餐厅;川菜"); split so
      // it reads like the string array every other provider returns.
      types: amapText(poi.type).split(/[;|]/).map((t) => t.trim()).filter(Boolean),
      // Amap gives opening hours as free text in the same dialect OSM uses for
      // simple cases, so the existing parser gets a chance at it; unparseable
      // text is still worth showing verbatim.
      opening_hours: openText ? parseOpeningHours(openText).weekdayDescriptions : null,
      open_now: openText ? parseOpeningHours(openText).openNow : null,
      opening_periods: null,
      opening_special_days: null,
      summary: null,
      reviews: [],
      source: 'amap' as const,
    };
  }

  // ── PlacesProvider ─────────────────────────────────────────────────────────

  async searchText(query: string, lang?: string, bias?: SearchBias): Promise<ProviderPlace[]> {
    const common = {
      keywords: query,
      offset: '10',
      page: '1',
      extensions: 'all',
      language: toAmapLang(lang),
    };

    // `place/around` rather than `place/text` when we know where the user is
    // looking: Amap's text search has no bias parameter at all, so without this
    // a search for "咖啡" from a Shanghai viewport returns Beijing.
    const data = bias
      ? await this.call<AmapEnvelope & { pois?: AmapPoi[] }>(
          '/v3/place/around',
          {
            ...common,
            location: toAmapLocation(bias.lat, bias.lng),
            // Amap caps the radius at 50 km, which is also the default the
            // Google path uses for an unspecified bias.
            radius: String(Math.min(Math.round(bias.radius ?? 50000), 50000)),
          },
          'place/around',
        )
      : await this.call<AmapEnvelope & { pois?: AmapPoi[] }>('/v3/place/text', common, 'place/text');

    return (data.pois ?? [])
      .map((poi) => this.toPlace(poi))
      .filter((p): p is ProviderPlace => p !== null);
  }

  async autocomplete(
    input: string,
    lang?: string,
    bias?: ViewportBias,
    // Amap does not bill per keystroke and has no session concept, so the token
    // the Google path uses to group a search has nothing to attach to here.
    _sessionToken?: string,
  ): Promise<ProviderSuggestion[]> {
    const params: Record<string, string> = {
      keywords: input,
      // Without this, inputtips also returns bus stops and road names, which
      // cannot be turned into a place with coordinates.
      datatype: 'poi',
      language: toAmapLang(lang),
    };
    // inputtips biases around a point, not a rectangle: the viewport centre is
    // the closest thing we can give it.
    if (bias) {
      const lat = (bias.low.lat + bias.high.lat) / 2;
      const lng = (bias.low.lng + bias.high.lng) / 2;
      params.location = toAmapLocation(lat, lng);
    }

    const data = await this.call<AmapEnvelope & { tips?: AmapTip[] }>(
      '/v3/assistant/inputtips',
      params,
      'inputtips',
    );

    return (data.tips ?? [])
      // A tip without an id cannot be looked up afterwards, and inputtips does
      // return those (a district name, a road).
      .filter((tip) => amapText(tip.id))
      .slice(0, 5)
      .map((tip) => ({
        placeId: `${AMAP_PLACE_ID_PREFIX}${amapText(tip.id)}`,
        mainText: amapText(tip.name),
        secondaryText: [amapText(tip.district), amapText(tip.address)].filter(Boolean).join(' '),
      }));
  }

  async placeDetails(placeId: string, opts: DetailsOptions = {}): Promise<ProviderPlace | null> {
    const poiId = amapPoiId(placeId);
    if (!poiId) return null;

    // v5 rather than v3: v3's place/detail is deprecated and does not return the
    // business block (rating, phone, opening hours) that makes a details lookup
    // worth making. `show_fields` is v5's field mask — asking for everything
    // costs no more, but photos are left out on purpose (see the file header).
    const data = await this.call<AmapEnvelope & { pois?: AmapPoi[] }>(
      '/v5/place/detail',
      {
        id: poiId,
        show_fields: 'business,indoor',
        language: toAmapLang(opts.lang),
      },
      `place/detail(${poiId})`,
    );

    const poi = data.pois?.[0];
    if (!poi) return null;
    const place = this.toPlace(poi);
    return place ? { ...place, cached_at: Date.now() } : null;
  }

  /**
   * Reverse geocoding via `geocode/regeo`.
   *
   * Worth having beyond the datum: the OSM path funnels through a single
   * process-wide Nominatim throttle of one request every 1.1 s (Nominatim's
   * usage policy), so a booking import that geocodes thirty stops takes half a
   * minute of wall clock. Amap has no such rule, so an install on Amap gets its
   * imports back at network speed.
   */
  async reverse(lat: number, lng: number, lang?: string): Promise<{ name: string | null; address: string | null } | null> {
    const data = await this.call<
      AmapEnvelope & {
        regeocode?: {
          formatted_address?: unknown;
          addressComponent?: { building?: { name?: unknown }; neighborhood?: { name?: unknown } };
          pois?: { name?: unknown }[];
          aois?: { name?: unknown }[];
        };
      }
    >(
      '/v3/geocode/regeo',
      {
        location: toAmapLocation(lat, lng),
        extensions: 'all',
        // 18 is street-address detail, matching the zoom the Nominatim path asks for.
        radius: '200',
        language: toAmapLang(lang),
      },
      'geocode/regeo',
    );

    const regeocode = data.regeocode;
    if (!regeocode) return null;

    // Same precedence as the Nominatim path: the most specific name Amap knows,
    // falling back through the containing area. An AOI ("故宫博物院") beats a POI
    // here because the click landed inside it rather than on it.
    const name =
      amapText(regeocode.aois?.[0]?.name) ||
      amapText(regeocode.pois?.[0]?.name) ||
      amapText(regeocode.addressComponent?.building?.name) ||
      amapText(regeocode.addressComponent?.neighborhood?.name) ||
      null;

    return { name, address: amapText(regeocode.formatted_address) || null };
  }
}

/**
 * Coordinates and a name out of a shared Amap link.
 *
 * The formats people paste, in the order they are tried:
 *   - `uri.amap.com/marker?position=<lng>,<lat>&name=…` — what our own "open in
 *     Amap" links look like, and what the mobile app's share sheet produces
 *   - `amap.com/place/<id>` or `…/detail?id=<id>` — a POI page, whose id we can
 *     look up when a key is configured
 *   - `?p=…` / `#…` viewport fragments carrying a bare `lng,lat`
 *
 * Returned coordinates are WGS-84; the link carries GCJ-02.
 */
export function parseAmapUrl(rawUrl: string): { lat: number; lng: number; name: string | null; poiId: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isAmapHost(parsed.hostname)) return null;

  const name = parsed.searchParams.get('name')?.trim() || null;
  const poiId = parsed.searchParams.get('id')?.trim() || parsed.pathname.match(/\/place\/([A-Za-z0-9]+)/)?.[1] || null;

  // `position=lng,lat` (uri.amap.com) and `p=…,lng,lat,…` (the web viewport) both
  // spell longitude first, like every other Amap coordinate.
  const position = parsed.searchParams.get('position') || parsed.searchParams.get('location');
  const fromPosition = position ? fromAmapLocation(position) : null;
  if (fromPosition) return { ...fromPosition, name, poiId };

  const anywhere = /(\d{2,3}\.\d+),(\d{1,2}\.\d+)/.exec(`${parsed.search}${parsed.hash}`);
  if (anywhere) {
    const converted = gcj02ToWgs84(Number.parseFloat(anywhere[2]), Number.parseFloat(anywhere[1]));
    return { ...converted, name, poiId };
  }

  return poiId ? { lat: Number.NaN, lng: Number.NaN, name, poiId } : null;
}

/**
 * Amap's own hosts, including the short-link one.
 *
 * Matched by exact suffix rather than by shape: unlike Google, Amap has no
 * ccTLD family, so a pattern would only widen what counts as trusted.
 */
const AMAP_HOSTS = new Set([
  'amap.com',
  'www.amap.com',
  'uri.amap.com',
  'wb.amap.com',
  'surl.amap.com',
  'gaode.com',
  'www.gaode.com',
]);

export function isAmapHost(hostname: string): boolean {
  return AMAP_HOSTS.has(hostname.toLowerCase());
}

/** The short links that have to be followed before anything can be parsed out. */
export const AMAP_SHORT_HOSTS = ['surl.amap.com'];
