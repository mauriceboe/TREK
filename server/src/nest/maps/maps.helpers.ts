import { readEnv, getAppUrl } from '../../app-config';
import { stripHtmlTags } from '../common/stripHtmlTags';

/**
 * Pure maps/geo helpers — no DB, no Nest, no side effects beyond reading env.
 *
 * Moved verbatim from the legacy services/mapsService.ts when the maps domain
 * went DI-native. Kept as plain functions (files.constants.ts / client-ip.ts
 * precedent) because they are consumed both by MapsService and by plain-module
 * code outside the container (transitService's User-Agent, the unit suites'
 * parser cases).
 */

// Overpass, Nominatim and Wikimedia all ask that requests carry a User-Agent that
// uniquely identifies the deploying instance — a shared, generic UA gets rate-limited
// and throttled harder (see #1309). When the instance URL is configured we append it;
// getAppUrl()'s bare http://localhost fallback isn't a useful identifier, so we drop it.
export function buildUserAgent(instanceUrl: string | undefined): string {
  const base = 'TREK Travel Planner (https://github.com/liketrek/TREK)';
  if (instanceUrl && !instanceUrl.startsWith('http://localhost')) return `${base}; ${instanceUrl}`;
  return base;
}
// Computed once at load — getAppUrl() reads only env vars, which don't change at runtime.
export const UA = buildUserAgent(getAppUrl());

/**
 * The fields places:searchText is asked for.
 *
 * Here rather than beside the call because the admin panel's key test has to
 * send the same mask: a key restricted to a narrower set of Places SKUs answers
 * a one-field probe with 200 and the real search with 403, which is the second
 * way to reach the #1939 report ("test button green, searching fails").
 */
export const SEARCH_TEXT_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.websiteUri,places.nationalPhoneNumber,places.types,places.googleMapsUri,places.businessStatus';

// TREK's internal language codes mostly coincide with valid BCP-47 codes, but a
// couple don't: 'br' is Brazilian Portuguese here (BCP-47 'pt-BR'; bare 'br' is
// Breton) and 'gr' is Greek (BCP-47 'el'). Outbound geo APIs (Google Places,
// Nominatim) expect BCP-47, so normalise before sending — otherwise names and
// opening hours come back in the wrong language. Codes not listed here pass
// through unchanged (they are already valid), as do locale forms the client
// sometimes sends (e.g. 'pt-BR').
const API_LANG_OVERRIDES: Record<string, string> = {
  br: 'pt-BR',
  gr: 'el',
  'el-GR': 'el',
};
export function toApiLang(lang: string | undefined, fallback = 'en'): string {
  const code = (lang || '').trim();
  if (!code) return fallback;
  return API_LANG_OVERRIDES[code] ?? code;
}

/**
 * A wiki subdomain out of a TREK language code.
 *
 * Not the same normalisation as `toApiLang`, and the difference bites: TREK
 * calls Brazilian Portuguese `br`, but `br.wikipedia.org` exists and is the
 * BRETON Wikipedia. Passing the raw code through would not fail — it would
 * quietly return Breton articles. `pt-br.wikipedia.org` does not resolve at
 * all, so the region subtag has to go as well.
 */
const WIKI_LANG_OVERRIDES: Record<string, string> = {
  br: 'pt',
  gr: 'el',
};
export function toWikiLang(lang: string | undefined, fallback = 'en'): string {
  const raw = (lang || '').trim();
  if (!raw) return fallback;
  const mapped = WIKI_LANG_OVERRIDES[raw] ?? raw;
  const base = mapped.split('-')[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(base) ? base : fallback;
}

// Re-exported, not redefined: this was one of three copies. Kept as an export
// here because callers and a test import it from maps.helpers.
export { haversineMetres } from '../common/geo';

/**
 * Whether two place names plausibly refer to the same thing.
 *
 * The gate that keeps a coordinate-based lookup from confidently describing the
 * wrong building. "Hamburg Airport" and "Flughafen Hamburg" pass on "hamburg";
 * "Hamburg Airport" and "Bahnhof Ohlsdorf" do not.
 *
 * One shared word is enough only when it carries some weight — four letters or
 * more. Otherwise two have to match. A single short word is almost always an
 * article or a generic noun, and TREK speaks 23 languages, so "Der Kiosk" and
 * "Der Bahnhof" would sail through a plain word-overlap test while a stopword
 * list for all of them is its own maintenance problem. Anything the pair rule
 * lets through has already survived the distance check.
 */
export function namesOverlap(a: string, b: string): boolean {
  const words = (value: string): Set<string> =>
    new Set(
      value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2),
    );
  const left = [...words(a)];
  if (left.length === 0) return false;

  /**
   * Same word, allowing for an inflected ending.
   *
   * Providers localise names, and the two sides of this comparison rarely come
   * from the same language: searching "Hamburg Airport" returns "Hamburger
   * Flughafen Helmut Schmidt", and a plain equality test rejects its own
   * correct answer over the "-er". A short prefix would over-match, so the
   * shared stem has to carry weight and the endings have to be close.
   */
  const sameStem = (x: string, y: string): boolean => {
    if (x === y) return true;
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return short.length >= 4 && long.length - short.length <= 3 && long.startsWith(short);
  };

  let shared = 0;
  for (const word of words(b)) {
    const match = left.find((candidate) => sameStem(candidate, word));
    if (!match) continue;
    if (Math.min(match.length, word.length) >= 4) return true;
    if (++shared >= 2) return true;
  }
  return false;
}

const GOOGLE_FTID_RE = /^0x[0-9a-f]+:0x[0-9a-f]+$/i;
// The same id inside the `data=` pathname blob, where a resolved share link keeps it:
// /maps/place/<name>/data=!4m6!3m5!1s0x47e66e1f06e2b70f:0x40b82c3688c9460!8m2!3d48.85!4d2.29
const GOOGLE_FTID_DATA_RE = /!1s(0x[0-9a-f]{1,20}:0x[0-9a-f]{1,20})/i;

// Extracts a Google Maps feature id (ftid, 0x..:0x..) from a URL.
// Two shapes carry it. The `?ftid=` query parameter is the old one. A share link that
// resolveGoogleMapsUrl has followed to its final hop carries it instead in the `data=`
// pathname blob, in the same `!1s…!3d…!4d…` run the coordinates come from (#1954) — so
// reading only the query parameter dropped the id for every pasted maps.app.goo.gl link.
// The Places API (New) googleMapsUri is usually a cid-style URL (https://maps.google.com/?cid=NNN)
// with neither, so this still returns null for most API responses — the precise
// query_place_id link is used instead.
export function googleFtidFromMapsUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const ftid = parsed.searchParams.get('ftid')?.trim();
    if (ftid && GOOGLE_FTID_RE.test(ftid)) return ftid.toLowerCase();
    // Only for a place URL. A /maps/dir/ route carries one !1s per waypoint and the
    // first one is the origin, not the place the link is about.
    if (!parsed.pathname.includes('/place/')) return null;
    const fromPath = GOOGLE_FTID_DATA_RE.exec(parsed.pathname)?.[1];
    return fromPath ? fromPath.toLowerCase() : null;
  } catch {
    return null;
  }
}

// ── Overpass POI categories ──────────────────────────────────────────────────

export interface OverpassPoi {
  osm_id: string; // 'node:123' | 'way:123' | 'relation:123' (matches the placeId format elsewhere)
  name: string;
  lat: number;
  lng: number;
  category: string; // the requested pill category key, e.g. 'restaurant'
  poi_type: string; // the raw OSM tag that matched, e.g. 'amenity=restaurant'
  address: string | null;
  website: string | null;
  phone: string | null;
  opening_hours: string | null;
  cuisine: string | null;
  source: 'openstreetmap';
}

// Each pill category → the OSM tag selectors it searches. Keys here are the
// contract with the client's POI_CATEGORIES (same keys, label/icon/colour live
// client-side).
export const CATEGORY_OSM_FILTERS: Record<string, string[]> = {
  restaurant: ['amenity=restaurant', 'amenity=fast_food'],
  cafe: ['amenity=cafe'],
  bar: ['amenity=bar', 'amenity=pub', 'amenity=nightclub'],
  hotel: ['tourism=hotel', 'tourism=hostel', 'tourism=guest_house', 'tourism=apartment', 'tourism=motel'],
  sights: [
    'tourism=attraction',
    'tourism=viewpoint',
    'historic=monument',
    'historic=castle',
    'historic=memorial',
    'historic=ruins',
  ],
  museum: ['tourism=museum', 'tourism=gallery', 'tourism=artwork', 'amenity=theatre'],
  nature: ['leisure=park', 'leisure=garden', 'natural=beach', 'natural=peak'],
  activity: ['tourism=theme_park', 'tourism=zoo', 'tourism=aquarium', 'leisure=water_park'],
  shopping: ['shop=mall', 'shop=department_store', 'amenity=marketplace'],
  supermarket: ['shop=supermarket', 'shop=convenience'],
};

export const POI_CATEGORY_KEYS = Object.keys(CATEGORY_OSM_FILTERS);

// Public Overpass mirrors, queried in PARALLEL (first valid response wins).
// Reachability and load vary a lot by network/region — the canonical instance is
// frequently overloaded (504s) and some community mirrors are unreachable from
// certain networks. Racing them means whichever mirror is fastest-reachable for
// this user answers, and an overloaded or blocked one never blocks the others.
const DEFAULT_OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Operators behind locked-down egress — or running their own Overpass — can point TREK
// at one or more custom endpoints via OVERPASS_URL (comma-separated). When set it
// REPLACES the public mirrors, so a firewalled cluster never reaches out to them and a
// self-hosted instance is used exclusively (see #1309). Non-http(s) entries are dropped.
export function resolveOverpassEndpoints(raw: string | undefined = readEnv().integrations.overpassUrl): string[] {
  const custom = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => {
      try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    });
  return custom.length ? custom : DEFAULT_OVERPASS_MIRRORS;
}

// Per-mirror fetch cap. Because mirrors race in parallel this is also the worst-case
// wait before every mirror is given up on and a 502 is returned. Public mirrors answer
// in 1–2s when reachable, so the cap mainly bounds dead/blocked ones; operators with a
// slow self-hosted endpoint can raise it via OVERPASS_TIMEOUT_MS. A non-positive or
// non-numeric value falls back to the default — a 0/negative cap would abort every
// request immediately and 502 the search.
export function resolveOverpassTimeoutMs(raw?: string): number {
  if (raw === undefined) return readEnv().integrations.overpassTimeoutMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 12000;
}

// ── Opening hours parsing ────────────────────────────────────────────────────

export interface GoogleTimePoint {
  day?: number;
  hour?: number;
  minute?: number;
}

export interface GoogleOpeningHours {
  weekdayDescriptions?: string[];
  openNow?: boolean;
  periods?: { open?: GoogleTimePoint; close?: GoogleTimePoint }[];
  specialDays?: { date?: { year?: number; month?: number; day?: number } }[];
}

// Machine-readable opening hours, in Google's numbering: day 0 = Sunday … 6 = Saturday.
// The weekday descriptions next to them are display text in the requested language and
// cannot be parsed reliably; these can. A period without `close` is Google's way of
// saying the place never closes.
export interface OpeningTimePoint {
  day: number;
  hour: number;
  minute: number;
}
export interface OpeningPeriod {
  open: OpeningTimePoint;
  close: OpeningTimePoint | null;
}

// Places (New) speaks proto3 JSON, which leaves out fields that hold the default
// value — a period starting Sunday midnight arrives as `{}`, not as three zeroes.
function toTimePoint(point: GoogleTimePoint | undefined): OpeningTimePoint | null {
  if (!point || typeof point !== 'object') return null;
  const field = (value: unknown): number | null => {
    if (value === undefined || value === null) return 0;
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
  };
  const day = field(point.day);
  const hour = field(point.hour);
  const minute = field(point.minute);
  if (day === null || hour === null || minute === null) return null;
  if (day < 0 || day > 6 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { day, hour, minute };
}

export function normalizeOpeningPeriods(periods: GoogleOpeningHours['periods']): OpeningPeriod[] | null {
  if (!Array.isArray(periods) || periods.length === 0) return null;
  const result: OpeningPeriod[] = [];
  for (const period of periods) {
    const open = toTimePoint(period?.open);
    if (!open) continue;
    // A missing close means "never closes"; a close that is there but unusable makes
    // the whole period a guess, so it is dropped rather than read as round-the-clock.
    const close = period?.close == null ? null : toTimePoint(period.close);
    if (period?.close != null && !close) continue;
    result.push({ open, close });
  }
  return result.length > 0 ? result : null;
}

// Holidays and other exceptional days that the weekly periods do not describe. Google
// reports them as calendar dates; they travel to the client as YYYY-MM-DD so it can
// compare them against the place's own local date.
export function normalizeSpecialDays(specialDays: GoogleOpeningHours['specialDays']): string[] | null {
  if (!Array.isArray(specialDays) || specialDays.length === 0) return null;
  const dates: string[] = [];
  for (const entry of specialDays) {
    const date = entry?.date;
    if (!date) continue;
    const { year, month, day } = date;
    if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') continue;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!dates.includes(iso)) dates.push(iso);
  }
  return dates.length > 0 ? dates : null;
}

// "09:00-18:00", also the "20:00-02:00" and "00:00-24:00" spellings OSM uses.
const OSM_TIME_RANGE = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g;

/** Periods for one OSM weekday line. `dayIdx` is Monday-based, the output is not. */
function osmPeriods(dayIdx: number, timePart: string): OpeningPeriod[] {
  const day = (dayIdx + 1) % 7;
  const periods: OpeningPeriod[] = [];
  for (const match of timePart.matchAll(OSM_TIME_RANGE)) {
    const openHour = Number.parseInt(match[1], 10);
    const openMinute = Number.parseInt(match[2], 10);
    let closeHour = Number.parseInt(match[3], 10);
    const closeMinute = Number.parseInt(match[4], 10);
    if (openHour > 23 || openMinute > 59 || closeHour > 24 || closeMinute > 59) continue;
    // OSM writes the end of a day as 24:00, a clock reading Google's numbering has no
    // hour 24 — that is midnight of the following day, same as any range that wraps.
    let nextDay = closeHour * 60 + closeMinute <= openHour * 60 + openMinute;
    if (closeHour === 24) {
      if (closeMinute !== 0) continue;
      closeHour = 0;
      nextDay = true;
    }
    periods.push({
      open: { day, hour: openHour, minute: openMinute },
      close: { day: nextDay ? (day + 1) % 7 : day, hour: closeHour, minute: closeMinute },
    });
  }
  return periods;
}

export function parseOpeningHours(ohString: string): {
  weekdayDescriptions: string[];
  openNow: boolean | null;
  periods: OpeningPeriod[];
} {
  const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const result: string[] = LONG.map((d) => `${d}: ?`);
  const periods: OpeningPeriod[] = [];

  // "24/7" — and it is not an edge case. Every segment below needs a weekday
  // prefix to match, so this fell straight through, all seven lines stayed "?",
  // and `buildOsmDetails` then threw the whole thing away as unparseable. Which
  // is why airports, main stations and petrol stations — the places most likely
  // to be tagged this way — showed no opening hours at all.
  if (/^\s*(24\/7|open)\s*$/i.test(ohString)) {
    return {
      weekdayDescriptions: LONG.map((d) => `${d}: 00:00-24:00`),
      openNow: true,
      // One period that never closes. `close: null` is how the client's
      // open/closed logic already spells "does not close".
      periods: [{ open: { day: 0, hour: 0, minute: 0 }, close: null }],
    };
  }

  // Parse segments like "Mo-Fr 09:00-18:00; Sa 10:00-14:00"
  for (const segment of ohString.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    // The time part is `\S.*`, not `.+`: the segment was trimmed above, so both
    // spell "everything after the gap". But `\s+(.+)` lets the gap and the time
    // part fight over the same spaces, and a segment that is a weekday followed by
    // nothing but blanks then costs a pass per space.
    const match = trimmed.match(
      /^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+(\S.*)$/i,
    );
    if (!match) continue;
    const [, daysPart, timePart] = match;
    const dayIndices = new Set<number>();
    for (const range of daysPart.split(',')) {
      const parts = range
        .trim()
        .split('-')
        .map((d) => DAYS.indexOf(d.trim()));
      if (parts.length === 2 && parts[0] >= 0 && parts[1] >= 0) {
        // do/while, not while: a range that wraps all the way round — "Mo-Su",
        // or "Tu-Mo", both of which mean every day — starts already satisfying
        // the exit condition, so the loop never ran and only the closing day
        // was added. "Mo-Su 11:30-23:00" is how a place open daily is usually
        // tagged, and it produced exactly one day of hours.
        let day = parts[0];
        do {
          dayIndices.add(day);
          day = (day + 1) % 7;
        } while (day !== (parts[1] + 1) % 7);
      } else if (parts[0] >= 0) {
        dayIndices.add(parts[0]);
      }
    }
    for (const idx of dayIndices) {
      result[idx] = `${LONG[idx]}: ${timePart.trim()}`;
      periods.push(...osmPeriods(idx, timePart));
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
      openNow = timeRanges.some((m) => {
        const start = Number.parseInt(m[1]) * 60 + Number.parseInt(m[2]);
        const end = Number.parseInt(m[3]) * 60 + Number.parseInt(m[4]);
        return end > start ? nowMins >= start && nowMins < end : nowMins >= start || nowMins < end;
      });
    }
  } catch {
    /* best effort */
  }

  return { weekdayDescriptions: result, openNow, periods };
}

// ── Build standardized OSM details ───────────────────────────────────────────

export function buildOsmDetails(tags: Record<string, string>, osmType: string, osmId: string) {
  let opening_hours: string[] | null = null;
  let open_now: boolean | null = null;
  let opening_periods: OpeningPeriod[] | null = null;
  if (tags.opening_hours) {
    const parsed = parseOpeningHours(tags.opening_hours);
    const hasData = parsed.weekdayDescriptions.some((line) => !line.endsWith('?'));
    if (hasData) {
      opening_hours = parsed.weekdayDescriptions;
      open_now = parsed.openNow;
      opening_periods = parsed.periods.length > 0 ? parsed.periods : null;
    }
  }
  return {
    website: tags['contact:website'] || tags.website || null,
    phone: tags['contact:phone'] || tags.phone || null,
    opening_hours,
    open_now,
    opening_periods,
    osm_url: `https://www.openstreetmap.org/${osmType}/${osmId}`,
    summary: tags.description || null,
    // Kept so enrichment can resolve the right Wikipedia article instead of
    // guessing one from the place name, which picks the wrong article whenever
    // the name is ambiguous ("Bahnhofstraße", "Rathaus", any chain restaurant).
    wikipedia: tags.wikipedia || null,
    wikidata: tags.wikidata || null,
    // A Commons category is pictures OF this place, where a coordinate search
    // only finds whatever was photographed near it.
    wikimedia_commons: tags.wikimedia_commons || null,
    // The tags that make the difference for a restaurant or a shop: no
    // encyclopaedia will ever describe one, but its cuisine, its hours and a
    // link to its menu are usually right here.
    cuisine: tags.cuisine || null,
    menu_url: tags['website:menu'] || tags.menu || null,
    outdoor_seating: tags.outdoor_seating || null,
    takeaway: tags.takeaway || null,
    delivery: tags.delivery || null,
    wheelchair: tags.wheelchair || null,
    diet_vegetarian: tags['diet:vegetarian'] || null,
    diet_vegan: tags['diet:vegan'] || null,
    internet_access: tags.internet_access || null,
    source: 'openstreetmap' as const,
  };
}

// ── Wiki metadata ────────────────────────────────────────────────────────────

/**
 * Commons extmetadata values arrive as HTML fragments — an author is typically
 * an <a> to the uploader's user page, a licence can carry <span> wrappers. We
 * show these as plain text next to a thumbnail, so the markup has to go.
 */
export function stripWikiMarkup(value: string | undefined | null): string | null {
  if (!value) return null;
  const text = stripHtmlTags(value, ' ')
    .replaceAll('&nbsp;', ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/**
 * Splits an OSM `wikipedia` tag ("de:Museum Ludwig") into host language and
 * article title. Returns null for the bare-title spelling, which has no language
 * and would send us to the wrong wiki.
 */
export function parseWikipediaTag(tag: string | undefined | null): { lang: string; title: string } | null {
  if (!tag) return null;
  const match = /^([a-z-]{2,12}):(.+)$/i.exec(tag.trim());
  if (!match) return null;
  const title = match[2].trim();
  return title ? { lang: match[1].toLowerCase(), title } : null;
}

// ── Place-id classification ──────────────────────────────────────────────────

// Ids that can never resolve against the Google Places API: coordinate pseudo-ids
// (right-click places, in both the coords: and the bare "lat,lng" spelling the
// collection views send), OSM ids the client sends when a place has no
// google_place_id, Amap POI ids (`amap:<poiid>`, which are otherwise shaped
// exactly like a Google id), the raw photo URLs legacy rows keep in image_url,
// and photo cache keys of the form "<placeId>~p3" that enrichment mints for the
// picker. Google answers those with a billable 400 INVALID_ARGUMENT, so every
// lookup sorts them out before the call and uses the right provider instead.
const NON_GOOGLE_PLACE_ID =
  /^(?:coords|node|way|relation|amap):|^https?:\/\/|^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$|~p\d+$/i;
// The subset that still has a provider behind it — Overpass for details,
// Wikimedia for photos.
export const OSM_PLACE_ID = /^(?:node|way|relation):/i;

export function isGooglePlaceId(placeId: string): boolean {
  return !NON_GOOGLE_PLACE_ID.test(placeId);
}

// ── Ranking Commons candidates ───────────────────────────────────────────────

/**
 * A candidate as the ranker needs to see it. Structurally the subset of
 * `CommonsCandidate` it reads, kept local so the pure function does not have to
 * import from the service that imports this file.
 */
export interface RankableCommonsCandidate {
  pageId: number | null;
  title: string | null;
  attribution: string | null;
  width: number | null;
  height: number | null;
  descriptors: string | null;
  photoUrl: string;
}

/**
 * Commons files that are near a place but are not a picture of it.
 *
 * Orthophotos are the worst offender by volume: German states upload their
 * aerial survey tiles to Commons with coordinates, so a geosearch around any
 * airport returns the runway as seen from a plane at 3000m — four of them for
 * Hamburg, one per survey year. The rest are documents that happen to live in a
 * place's category: noise maps, floor plans, terminal layouts, logos, coats of
 * arms.
 */
const NOT_A_PHOTO_OF_THE_PLACE =
  /orthophoto|orthofoto|sommerbefliegung|luftbildkarte|dop\d+|l[äa]rmkarte|noise map|floor ?plan|grundriss|lageplan|layout|diagram|schematic|blueprint|coat of arms|wappen|\blogo\b|flag of/i;

/**
 * Strips what makes two frames of the same burst look like different files, so
 * they collapse onto one stem: trailing counters, camera dumps, dates, and the
 * `- 17` / `(2)` suffixes press sets use.
 */
function seriesStem(title: string): string {
  return title
    .replace(/^File:/i, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    // 20260614 100717648 HDR — a camera dump, all from the same minute
    .replace(/\b\d{8}[ _-]\d{6,9}\b/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    // The character in front of the suffix is matched and put straight back:
    // /[ _-]+…$/ on its own restarts at every space of a title that has no such
    // suffix, and re-reads the rest of the run each time.
    .replace(/([^ _-]|^)[ _-]+\(?\d{1,4}\)?$/g, '$1')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

/**
 * Picks the pictures worth showing out of whatever the providers returned.
 *
 * Everything here was written against a real failing case. Deduplication is by
 * page id because the same file reaches us under different thumbnail URLs. The
 * series rule exists because Commons categories are full of bursts — the four
 * `Hauptbahnhof Berlin interior 0807..0810` shots that filled the picker were
 * one person walking across a concourse. The author cap is the same problem
 * seen from the other side: one contributor who documented a station thoroughly
 * should not supply the whole strip.
 *
 * `perAuthor` is the one knob: coordinate search gets 1, because there being no
 * evidence the pictures are even of the right subject makes variety the only
 * defence. Curated sources get 2 — someone already vouched that these depict
 * the place.
 */
export function rankCommonsCandidates<T extends RankableCommonsCandidate>(
  candidates: T[],
  limit: number,
  opts: { perAuthor?: number } = {},
): T[] {
  const perAuthor = opts.perAuthor ?? 2;
  const seenPages = new Set<number>();
  const seenUrls = new Set<string>();
  const seenStems = new Set<string>();
  const authorCounts = new Map<string, number>();
  const out: T[] = [];

  for (const candidate of candidates) {
    if (out.length >= limit) break;

    if (candidate.pageId != null) {
      if (seenPages.has(candidate.pageId)) continue;
    } else if (seenUrls.has(candidate.photoUrl)) {
      // No page id (an older payload, or a provider that does not report one):
      // the URL is a weaker key but better than letting an exact repeat through.
      continue;
    }

    const haystack = `${candidate.title ?? ''} ${candidate.descriptors ?? ''}`;
    if (NOT_A_PHOTO_OF_THE_PLACE.test(haystack)) continue;

    const { width, height } = candidate;
    if (width && height) {
      // Survey tiles are square and enormous; nothing photographed by hand is.
      if (width === height && width >= 3000) continue;
      const ratio = Math.max(width / height, height / width);
      // Panorama strips and tall banners crop to nothing in a square tile.
      if (ratio > 4) continue;
    }

    const stem = candidate.title ? seriesStem(candidate.title) : '';
    if (stem && seenStems.has(stem)) continue;

    const author = (candidate.attribution ?? '').trim().toLowerCase();
    if (author) {
      const used = authorCounts.get(author) ?? 0;
      if (used >= perAuthor) continue;
      authorCounts.set(author, used + 1);
    }

    if (candidate.pageId != null) seenPages.add(candidate.pageId);
    seenUrls.add(candidate.photoUrl);
    if (stem) seenStems.add(stem);
    out.push(candidate);
  }

  return out;
}
