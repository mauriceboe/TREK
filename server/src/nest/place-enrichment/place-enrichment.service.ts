import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { placeWebsiteSchema } from '@trek/shared';
import type {
  MapsPlaceEnrichmentRequest,
  MapsPlaceEnrichmentResult,
  PlaceDescription,
  PlaceFact,
  PlaceHours,
  PlacePhotoCandidate,
  PlaceRating,
} from '@trek/shared';
import { safeFetchFollow } from '../../utils/ssrfGuard';
import { DatabaseService } from '../database/database.service';
import {
  MapsService,
  readBrandIdentity,
  readWikiIdentity,
  withPhotoFetchSlot,
  type CommonsCandidate,
  type WikiIdentity,
} from '../maps/maps.service';
import { buildOsmDetails, isGooglePlaceId, parseWikipediaTag, rankCommonsCandidates, toWikiLang } from '../maps/maps.helpers';
import { PlacePhotoCacheService } from '../place-photos/place-photo-cache.service';

/**
 * How many pictures each source may contribute.
 *
 * Commons is generous because geosearch returns the whole strip in one request
 * either way. Google is not: the reference list is one billed call, but every
 * picture we actually show costs a second billed /media call, on the key of an
 * admin who may not be watching the bill. Three is enough to choose from.
 */
const COMMONS_CAP = 5;
const GOOGLE_CAP = 3;

/**
 * Enrichment results live in the same table as the plain details cache, under a
 * third `expanded` value. Descriptions and the set of pictures near a place
 * change on the order of months, so a week is short enough to pick up edits and
 * long enough that a re-opened planner never pays for the same place twice.
 */
const CACHE_KIND = 2;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A week is right for an answer, and far too long for the absence of one.
 *
 * Nothing found is usually the provider having a bad minute — a Wikimedia
 * timeout, a rate limit, a Nominatim hiccup — not a place that genuinely has no
 * pictures and no article. Storing that under the same TTL means one unlucky
 * request leaves the column blank for the rest of the week, which is exactly
 * how a fix can look like no fix at all when it lands.
 */
const EMPTY_CACHE_TTL_MS = 10 * 60 * 1000;

/** Whether an answer is worth keeping for a week. */
function hasAnything(value: CachedEnrichment): boolean {
  return !!(value.photos.length || value.description || value.facts.length || value.hours || value.rating);
}
/**
 * Bumped whenever the shape or the sources change. Without it a release that
 * adds a field or swaps a provider keeps serving the previous week's answers
 * from before the change — which is exactly what happened when the facts and
 * Wikivoyage landed.
 */
const CACHE_VERSION = 4;

/**
 * Cache key for one candidate picture. Deliberately not a bare place id.
 *
 * Keyed by which picture it is, not by where it sat in the strip. Position was
 * the obvious choice and it was wrong: the ladder below returns different
 * numbers of candidates depending on which providers answered, so a slot that
 * held a Wikidata photo one minute held a category photo the next — and the
 * cache hands back whatever bytes it stored for that slot while the response
 * carries the new candidate's author. Under CC BY that is not a stale
 * thumbnail, it is the wrong person credited for someone's work.
 *
 * Hashed because the identity can be a Google resource path with slashes, and
 * this ends up in a URL.
 */
export function candidateKey(placeId: string, identity: string): string {
  const digest = createHash('sha1').update(identity).digest('hex').slice(0, 12);
  return `${placeId}~p${digest}`;
}

/**
 * What the free sources need to know about a place, kept apart from whatever
 * the maps provider returned. See `resolveIdentity` for why they do not merge.
 */
interface PlaceIdentity extends WikiIdentity {
  /** Full OSM tag set, when the identity came from a Nominatim lookup. */
  osmTags: Record<string, string> | null;
  /**
   * The chain this place belongs to. Kept apart from the fields above on
   * purpose — it describes something else, and only the description is allowed
   * to fall back to it. The picture ladder never reads it.
   */
  brand: { wikidata: string | null; wikipedia: string | null };
}

/** A ranked Commons pick, tagged with the rung of the ladder it came from. */
type CommonsPick = CommonsCandidate & { rung: 'wikidata' | 'wikipedia' | 'category' | 'nearby' };

interface PendingCandidate {
  /** Stable identity of the underlying file, for the cache key. */
  identity: string;
  candidate: PlacePhotoCandidate;
  fetchBytes: () => Promise<Buffer | null>;
}

/** Appends candidates to the pool, remembering which rung produced them. */
function push(pool: CommonsPick[], candidates: CommonsCandidate[], rung: CommonsPick['rung']): void {
  for (const candidate of candidates) pool.push({ ...candidate, rung });
}

/**
 * The credit line stored alongside a cached picture.
 *
 * `google_place_photo_meta` has one TEXT column for this, so author and licence
 * go in together rather than the author alone. A picture chosen here can end up
 * on the map, in the PDF and behind a share link long after the dialog is gone,
 * and at that point this string is the only record of who made it.
 */
export function creditLine(attribution: string | null, license: string | null): string | null {
  if (attribution && license) return `${attribution} · ${license}`;
  return attribution || license || null;
}

interface CachedEnrichment {
  photos: PlacePhotoCandidate[];
  description: PlaceDescription | null;
  facts: PlaceFact[];
  hours: PlaceHours | null;
  rating: PlaceRating | null;
}

interface CachePayload extends CachedEnrichment {
  v?: number;
}

/**
 * Categories where a picture taken nearby is almost certainly of something
 * else, so the bottom rung of the ladder is skipped for them entirely.
 *
 * Measured across 600 places in six cities: 2 percent of ordinary businesses
 * have a picture on Wikimedia, against 70 percent of churches. So for a cafe
 * the curated rungs practically never fire and the fallback practically always
 * does, which is how the town hall ends up over the doner shop. A missing
 * picture is honest; a confident picture of the building opposite is not.
 *
 * Matched against the category the source reports: `basic_category` from the
 * TREK index, the amenity/shop tag from OpenStreetMap, a Google type.
 */
const NEARBY_MISLEADS = [
  'restaurant', 'cafe', 'coffee', 'bar', 'pub', 'bakery', 'fast_food', 'food',
  'eatery', 'biergarten', 'ice_cream', 'shop', 'store', 'supermarket', 'retail',
  'pharmacy', 'hairdresser', 'kiosk', 'convenience', 'butcher', 'greengrocer',
  'clothing', 'florist', 'bank', 'atm', 'nightclub',
];

/**
 * True when a nearby picture would more likely mislead than inform.
 *
 * Fails OPEN on an unknown category: without one we cannot tell a cathedral
 * from a kebab shop, and silently dropping pictures for everything unlabelled
 * would take them away from the places where the fallback actually works.
 */
export function nearbyWouldMislead(details: Record<string, unknown> | null): boolean {
  if (!details) return false;
  const haystack = [details.category, details.category_path, details.amenity, details.shop, details.cuisine]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  if (!haystack) return false;
  return NEARBY_MISLEADS.some(word => haystack.includes(word));
}

/** OSM yes/no tags; anything else (limited, only, designated) is shown verbatim. */
function yesNo(value: unknown): 'yes' | 'no' | string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

/**
 * Turns the place's OpenStreetMap tags into the short facts the column shows.
 *
 * This is the part that makes the column useful for a restaurant. No wiki will
 * ever describe one and Commons rarely has a picture of it, but its cuisine,
 * its opening hours and a link to its menu are usually right there in the tags
 * — and they arrive with a lookup that has already happened, so they are free.
 *
 * Only positive facts are listed. "No outdoor seating" is noise; a missing tag
 * and a deliberate `no` are indistinguishable to a reader either way.
 */
export function collectFacts(details: Record<string, unknown> | null): PlaceFact[] {
  if (!details) return [];

  const facts: PlaceFact[] = [];
  const push = (kind: PlaceFact['kind'], value: string | null, url: string | null = null) =>
    facts.push({ kind, value, url });

  // Rating and opening hours used to be squeezed in here as chips. They are not
  // chips: a rating wants stars and a week of hours wants a week of hours, and
  // flattening seven lines into one string produced "Monday: 11:30 AM – 11:00 PM
  // · Tuesday:…" truncated mid-word. Both now travel as their own fields.

  // Everything below is OpenStreetMap tagging and has no Google equivalent.
  if (details.source !== 'openstreetmap') return facts;

  const cuisine = typeof details.cuisine === 'string' ? details.cuisine : null;
  // OSM writes several cuisines semicolon-separated and underscored.
  if (cuisine) push('cuisine', cuisine.split(';').map((c) => c.replaceAll('_', ' ').trim()).filter(Boolean).join(', '));

  // `menu_url` is a community-editable OSM tag that becomes an href on the
  // client, so it goes through the same allow-list as a place's website —
  // anything but http(s) is dropped rather than rendered as a link.
  const menu = typeof details.menu_url === 'string' ? details.menu_url.trim() : '';
  if (placeWebsiteSchema.safeParse(menu).success) push('menu', null, menu);

  if (yesNo(details.outdoor_seating) === 'yes') push('outdoorSeating', null);
  if (yesNo(details.takeaway) === 'yes') push('takeaway', null);
  if (yesNo(details.delivery) === 'yes') push('delivery', null);

  const wheelchair = yesNo(details.wheelchair);
  if (wheelchair === 'yes' || wheelchair === 'limited') push('wheelchair', wheelchair);

  if (yesNo(details.diet_vegetarian) === 'yes' || yesNo(details.diet_vegetarian) === 'only') push('vegetarian', null);
  if (yesNo(details.diet_vegan) === 'yes' || yesNo(details.diet_vegan) === 'only') push('vegan', null);

  const internet = yesNo(details.internet_access);
  if (internet && internet !== 'no') push('internetAccess', null);

  return facts;
}

/**
 * The week's opening hours, both as the provider phrased them and as data.
 *
 * The two are not redundant. `weekdayDescriptions` is localised display text —
 * Google writes it in the requested language and it is unusable as a source.
 * `periods` is what "open now" has to be computed from, in the timezone of the
 * place rather than of the server; a boolean the provider computed and we then
 * cached for a week is wrong twice over when read from another continent.
 */
export function collectHours(details: Record<string, unknown> | null): PlaceHours | null {
  if (!details) return null;
  const lines = Array.isArray(details.opening_hours) ? (details.opening_hours as string[]) : null;
  if (!lines?.length) return null;
  return {
    weekdayDescriptions: lines,
    periods: (details.opening_periods as PlaceHours['periods']) ?? null,
    // buildOsmDetails does not set this at all; only Google reports it.
    specialDays: (details.opening_special_days as string[] | undefined) ?? null,
  };
}

/**
 * Facts from the maps provider, topped up from OpenStreetMap.
 *
 * Provider first where both know a thing: it is the source the user searched
 * and the one more likely to be current for a business. OSM contributes
 * everything the provider has no concept of, which for Google is most of this
 * list — cuisine, wheelchair access, outdoor seating, the menu link.
 */
export function mergeFacts(primary: PlaceFact[], extra: PlaceFact[]): PlaceFact[] {
  const seen = new Set(primary.map((fact) => fact.kind));
  return [...primary, ...extra.filter((fact) => !seen.has(fact.kind))];
}

/** The provider's star rating, with its count when there is one. */
export function collectRating(details: Record<string, unknown> | null): PlaceRating | null {
  const value = typeof details?.rating === 'number' ? details.rating : null;
  if (value == null) return null;
  return { value, count: typeof details?.rating_count === 'number' ? details.rating_count : null };
}

/**
 * Photos and a description for a place the user is looking at but has not saved
 * yet — the detail column next to the search field in the add-place dialog.
 *
 * Two things shape this service. First, most TREK instances have no Google key,
 * so the free path (OpenStreetMap tags, Wikimedia Commons, Wikipedia) is the
 * normal case and has to stand on its own; Google is an addition an admin opts
 * into, not the design centre. Second, every picture shown here is somebody
 * else's work, so a candidate carries its author and licence from the start
 * rather than having attribution bolted on later.
 */
@Injectable()
export class PlaceEnrichmentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly maps: MapsService,
    private readonly photoCache: PlacePhotoCacheService,
  ) {}

  /**
   * Fail-open, unlike the three older places_* switches: an instance that has
   * never seen this setting gets the feature. Reading it the other way round
   * would mean backfilling a row for every existing install just to keep them
   * working, and there is nothing here that warrants a migration.
   */
  enrichDisabled(): boolean {
    const row = this.database.get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', 'places_enrich_enabled');
    return row?.value === 'false';
  }

  async enrich(userId: number, req: MapsPlaceEnrichmentRequest): Promise<MapsPlaceEnrichmentResult> {
    if (this.enrichDisabled()) return { photos: [], description: null, facts: [], disabled: true };

    const placeId = req.placeId?.trim() || `coords:${req.lat}:${req.lng}`;
    const lang = req.lang;

    const cached = await this.readCache(placeId, lang);
    if (cached) return cached;

    // One details lookup feeds all three halves: the pictures need its Commons
    // category, the description needs its wiki tag, and the facts are its tags.
    // It is row-cached and the dialog just made the same call, so in practice
    // this is a cache read.
    // The dialog already fetched this when the user picked the result, so it
    // comes along with the request. Refetching cost 12.8 seconds on a large
    // OSM relation, and it ran in parallel with the client's own lookup.
    const details = req.details ?? (await this.readDetails(userId, placeId, lang));
    const identity = await this.resolveIdentity(req, details);

    const [photos, description] = await Promise.all([
      this.collectPhotos(userId, placeId, req, identity, details),
      this.collectDescription(userId, placeId, req, details, identity),
    ]);

    // The OSM record found while resolving the identity carries the same tags
    // an Overpass lookup would — cuisine, opening_hours, wheelchair. Reading
    // them here is what gives a Google place its hours and its facts without a
    // second billed Details call, and without an Overpass round trip that has
    // no transport deadline at all.
    const osmDetails = identity.osmTags ? buildOsmDetails(identity.osmTags, '', '') : null;

    // Where Google is silent, the free sources fill in. Google's payload has no
    // cuisine, no wheelchair access, no outdoor seating and no menu link — it
    // never had — so a Google place used to show a rating and nothing else,
    // while the same building in OpenStreetMap carried all of it. Each field is
    // taken from whichever source actually has it rather than from one source
    // for everything.
    const result: CachedEnrichment = {
      photos,
      description,
      facts: mergeFacts(collectFacts(details), collectFacts(osmDetails)),
      hours: collectHours(details) ?? collectHours(osmDetails),
      rating: collectRating(details) ?? collectRating(osmDetails),
    };
    this.writeCache(placeId, lang, result);
    return result;
  }

  /**
   * The stored credit for a cached picture, looked up by its cache key.
   *
   * The picker shows author and licence at the moment of choosing, but the
   * obligation does not end there — the place inspector reads this so a picture
   * that was chosen weeks ago still names whoever made it.
   */
  async credit(key: string): Promise<{ credit: string | null }> {
    return { credit: (await this.photoCache.get(key))?.attribution ?? null };
  }

  /**
   * Which encyclopaedia entry, Wikidata item and Commons category describe this
   * place.
   *
   * Kept beside the provider payload rather than merged into it, and that is
   * not tidiness. `collectFacts` and the OSM branch of `collectDescription`
   * both gate on `details.source`, so OSM tags folded into a Google payload
   * would be carried around and never read — or, worse, would make a Google
   * place start claiming to be an OpenStreetMap one.
   *
   * The lookup only runs when the payload brought nothing, which is every
   * Google place: Google's response has no wiki tags and never had, so before
   * this a configured API key silently switched the free half of this feature
   * off.
   */
  private async resolveIdentity(
    req: MapsPlaceEnrichmentRequest,
    details: Record<string, unknown> | null,
  ): Promise<PlaceIdentity> {
    const fromPayload = (key: string): string | null =>
      typeof details?.[key] === 'string' && (details[key] as string).trim() ? (details[key] as string).trim() : null;

    const carried: PlaceIdentity = {
      wikipedia: fromPayload('wikipedia'),
      wikidata: fromPayload('wikidata'),
      wikimedia_commons: fromPayload('wikimedia_commons'),
      osmTags: null,
      brand: { wikidata: null, wikipedia: null },
    };
    if (carried.wikipedia || carried.wikidata || carried.wikimedia_commons) return carried;

    const resolved = await this.maps.resolveOsmIdentity(req.name, req.lat, req.lng, { lang: req.lang });
    if (!resolved) return carried;
    return {
      ...readWikiIdentity(resolved.tags),
      osmTags: resolved.tags,
      brand: readBrandIdentity(resolved.tags),
    };
  }

  // ── Photos ─────────────────────────────────────────────────────────────────

  private async collectPhotos(
    userId: number,
    placeId: string,
    req: MapsPlaceEnrichmentRequest,
    identity: PlaceIdentity,
    /** The record the caller already holds; only its category is read. */
    details: Record<string, unknown> | null,
  ): Promise<PlacePhotoCandidate[]> {
    const apiKey = this.maps.getMapsKey(userId);
    const wantsGoogle = !!apiKey && !this.maps.photosDisabled() && isGooglePlaceId(placeId);

    const { wikidata, wikipedia } = identity;

    // Google's listing is one call for the whole strip and knows nothing about
    // the free sources, so it runs alongside them rather than in the ladder.
    const googlePending = wantsGoogle
      ? this.maps.fetchGooglePhotoRefs(placeId, apiKey!, GOOGLE_CAP)
      : Promise.resolve([] as { name: string; attribution: string | null }[]);

    // The free ladder, in order of how much anyone vouched that the picture
    // shows THIS place:
    //   Wikidata  — a person attached this file to this exact object.
    //   Wiki lead — the article about it opens with this picture.
    //   Category  — the set of pictures of it.
    //   Nearby    — anything photographed within 300m.
    // Only the last one has no claim on the subject at all, which is how an
    // airport ended up represented by aerial survey tiles of its runway and a
    // gate by the underground station beneath it. It is the fallback, and it
    // only runs when the ladder above came up short.
    const commonsPool: CommonsPick[] = [];
    let categoryName = identity.wikimedia_commons;

    if (wikidata) {
      const fromWikidata = await this.maps.fetchWikidataCandidates(wikidata, COMMONS_CAP);
      push(commonsPool, fromWikidata.candidates, 'wikidata');
      categoryName ??= fromWikidata.commonsCategory;
    }

    if (commonsPool.length < COMMONS_CAP && wikipedia) {
      const leadName = await this.maps.fetchWikiLeadImageName(wikipedia);
      if (leadName) {
        const byName = await this.maps.fetchCommonsFilesByName([leadName]);
        push(commonsPool, [...byName.values()], 'wikipedia');
      }
    }

    if (commonsPool.length < COMMONS_CAP && categoryName) {
      push(commonsPool, await this.maps.fetchCommonsCategoryCandidates(categoryName, COMMONS_CAP), 'category');
    }

    // Two is the bar: one curated picture plus the nearby noise reads worse
    // than one curated picture on its own.
    const curated = commonsPool.length;
    // Started here, decided below. Waiting for Google's listing first would put
    // two round trips end to end, and that is precisely the sequencing that
    // used to push this endpoint past the client's timeout. Geosearch is free
    // and unmetered, so a speculative call that gets discarded costs nothing
    // anyone pays for.
    // Skipped outright for the categories where it misleads, rather than
    // fetched and then filtered: the request is the cost, and there is nothing
    // in the answer worth looking at for a cafe.
    const skipNearby = nearbyWouldMislead(details) || nearbyWouldMislead(identity.osmTags);
    const nearbyPending =
      curated < 2 && !skipNearby
        ? this.maps.fetchCommonsCandidates(req.lat, req.lng, COMMONS_CAP)
        : Promise.resolve([]);

    const googleRefs = await googlePending;
    if (curated < 2 && googleRefs.length < GOOGLE_CAP) {
      push(commonsPool, await nearbyPending, 'nearby');
    }

    // One ranking pass over everything: the same file reaches us from several
    // rungs and only the page id catches that.
    const ranked = rankCommonsCandidates(commonsPool, COMMONS_CAP, { perAuthor: curated > 0 ? 2 : 1 });
    // Google leads the strip — its pictures are of the business itself.
    const pending: PendingCandidate[] = [
      ...googleRefs.map((ref) => ({
        identity: `google:${ref.name}`,
        candidate: {
          key: '',
          url: '',
          attribution: ref.attribution,
          // Google grants no reusable licence for these; the author line it
          // hands back is all we may show, so the rest stays honestly empty.
          license: null,
          licenseUrl: null,
          sourceUrl: null,
          source: 'google' as const,
        },
        fetchBytes: () => this.maps.fetchGooglePhotoBytes(ref.name, apiKey!),
      })),
      ...ranked.map((pick) => ({
        identity: `commons:${pick.pageId ?? pick.photoUrl}`,
        candidate: {
          key: '',
          url: '',
          attribution: pick.attribution,
          license: pick.license,
          licenseUrl: pick.licenseUrl,
          sourceUrl: pick.sourceUrl,
          source: (pick.rung === 'wikipedia' ? 'wikipedia' : 'wikimedia') as 'wikipedia' | 'wikimedia',
        },
        fetchBytes: () => this.fetchRemoteBytes(pick.photoUrl),
      })),
    ];

    // Download the bytes concurrently. Doing this in a loop meant a place with
    // five Commons hits spent five round trips plus five decodes in sequence,
    // which pushed the whole request past the client's request timeout. The
    // shared slot limiter still caps how many run at once.
    const results = await Promise.all(
      pending.map(async ({ identity, candidate, fetchBytes }) => {
        const key = candidateKey(placeId, identity);
        const url = await this.storeCandidate(key, creditLine(candidate.attribution, candidate.license), fetchBytes);
        return url ? { ...candidate, key, url } : null;
      }),
    );

    return results.filter((candidate): candidate is PlacePhotoCandidate => candidate !== null);
  }

  /**
   * Puts one picture in the shared photo cache and returns its proxy URL.
   *
   * Candidates are never hotlinked. A provider URL in the strip would send the
   * IP of everyone who opens the dialog to Google or Wikimedia, and Google's
   * photo URLs expire — which is exactly the bug migration 107 had to repair
   * for the pictures already stored. Whatever nobody picks is unreferenced and
   * the nightly sweep removes it.
   */
  private async storeCandidate(
    key: string,
    credit: string | null,
    fetchBytes: () => Promise<Buffer | null>,
  ): Promise<string | null> {
    const hit = await this.photoCache.get(key);
    if (hit) return hit.photoUrl;

    const bytes = await withPhotoFetchSlot(fetchBytes);
    if (!bytes?.length) return null;

    try {
      const stored = await this.photoCache.put(key, bytes, credit);
      return stored.photoUrl;
    } catch (err) {
      console.error('Failed to cache place enrichment photo:', err);
      return null;
    }
  }

  /** Downloads a non-Google image, re-checking every redirect hop against the SSRF guard. */
  private async fetchRemoteBytes(url: string): Promise<Buffer | null> {
    try {
      const res = await safeFetchFollow(url, undefined, { bypassInternalIpAllowed: true });
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      return bytes.length ? bytes : null;
    } catch {
      return null;
    }
  }

  // ── Description ────────────────────────────────────────────────────────────

  private async collectDescription(
    userId: number,
    placeId: string,
    req: MapsPlaceEnrichmentRequest,
    details: Record<string, unknown> | null,
    identity: PlaceIdentity,
  ): Promise<PlaceDescription | null> {
    // OpenStreetMap first: it costs nothing, it is already fetched, and a
    // description someone wrote into the map data beats a generated blurb.
    const osmSummary = typeof details?.summary === 'string' ? details.summary.trim() : '';
    if (osmSummary && details?.source === 'openstreetmap') {
      return {
        text: osmSummary,
        source: 'osm',
        sourceUrl: typeof details.osm_url === 'string' ? details.osm_url : null,
        license: 'ODbL 1.0',
      };
    }

    // Then the encyclopaedias. This used to sit BELOW Google, which read as a
    // detail and was in fact the whole problem: an instance with a key asked
    // Google, got nothing back for most places, and stopped — while a perfectly
    // good Wikivoyage article sat one call away. Free sources are the normal
    // case here and Google is the addition, so the order says so.
    const extract = await this.fetchWikiDescription(identity, req.lang);
    if (extract) {
      return { text: extract.text, source: extract.source, sourceUrl: extract.sourceUrl, license: 'CC BY-SA 4.0' };
    }

    const apiKey = this.maps.getMapsKey(userId);
    if (apiKey && !this.maps.detailsDisabled() && isGooglePlaceId(placeId)) {
      const summary = await this.maps.fetchEditorialSummary(placeId, apiKey, req.lang);
      if (summary) {
        return {
          text: summary,
          source: 'google',
          sourceUrl: typeof details?.google_maps_url === 'string' ? details.google_maps_url : null,
          license: null,
        };
      }
    }

    // Last, and about something else: the chain this place belongs to.
    //
    // A branch of a chain has no article of its own and never will, and Google
    // keeps no editorial summary for one either — L'Osteria Rostock came back
    // empty from every source above. The company does have an article, and
    // "L'Osteria is a German restaurant chain serving pizza and pasta" is worth
    // more than nothing as long as nobody mistakes it for a description of this
    // particular branch. The `aboutBrand` flag is what stops that: the column
    // heads the block differently, and it is the only reason this is allowed to
    // run at all. Note the pictures do NOT get the same treatment — a chain's
    // logo passed off as a photo of the restaurant would be a plain lie.
    const brand = await this.fetchWikiDescription(
      { ...identity, wikipedia: identity.brand.wikipedia, wikidata: identity.brand.wikidata },
      req.lang,
    );
    if (brand) {
      return {
        text: brand.text,
        source: brand.source,
        sourceUrl: brand.sourceUrl,
        license: 'CC BY-SA 4.0',
        aboutBrand: true,
      };
    }

    return null;
  }

  /**
   * The article about this place, in the reader's language where one exists.
   *
   * Two ways in, and a place usually has only one of them: mappers tag either
   * `wikipedia` or `wikidata`, rarely both. The Wikidata route goes through
   * sitelinks, which is also what makes the language choice honest — asking
   * `<userlang>.wikipedia.org` for a title taken from the German tag returns
   * nothing, so without sitelinks a German article is all a Korean reader could
   * ever get.
   *
   * Wikivoyage before Wikipedia at every step: it describes a place for someone
   * about to go there, where Wikipedia opens with area in square kilometres.
   */
  private async fetchWikiDescription(
    identity: PlaceIdentity,
    lang: string | undefined,
  ): Promise<{ text: string; sourceUrl: string; source: 'wikivoyage' | 'wikipedia' } | null> {
    const userLang = toWikiLang(lang);
    const tag = parseWikipediaTag(identity.wikipedia);

    if (identity.wikidata) {
      // The tag's own language is in the list because the place named that
      // article specifically; it beats falling through to English.
      const wanted: { site: string; host: 'wikivoyage' | 'wikipedia'; lang: string }[] = [
        { site: `${userLang}wikivoyage`, host: 'wikivoyage', lang: userLang },
        { site: `${userLang}wiki`, host: 'wikipedia', lang: userLang },
        ...(tag && tag.lang !== userLang
          ? [{ site: `${tag.lang}wiki`, host: 'wikipedia' as const, lang: tag.lang }]
          : []),
        { site: 'enwikivoyage', host: 'wikivoyage', lang: 'en' },
        { site: 'enwiki', host: 'wikipedia', lang: 'en' },
      ];
      const sitelinks = await this.maps.fetchWikidataSitelinks(
        identity.wikidata,
        wanted.map((w) => w.site),
      );
      for (const { site, host, lang: hostLang } of wanted) {
        const title = sitelinks[site];
        if (!title) continue;
        const hit = await this.maps.fetchWikiExtractFor(host, hostLang, title);
        if (hit) return hit;
      }
    }

    // No Wikidata id, or its sitelinks led nowhere: fall back to the tag, which
    // names an article directly.
    return identity.wikipedia ? this.maps.fetchWikiExtract(identity.wikipedia) : null;
  }

  /**
   * The place's own details, for the OSM tags and the Maps URL.
   *
   * This is the same lookup the dialog already made when the user picked the
   * search result, and it is row-cached, so in practice it is a cache read
   * rather than a second provider call.
   */
  private async readDetails(
    userId: number,
    placeId: string,
    lang: string | undefined,
  ): Promise<Record<string, unknown> | null> {
    try {
      const { place } = await this.maps.details(userId, placeId, lang);
      return place ?? null;
    } catch {
      return null;
    }
  }

  // ── Result cache ───────────────────────────────────────────────────────────

  private async readCache(placeId: string, lang: string | undefined): Promise<CachedEnrichment | null> {
    try {
      const row = this.database.get<{ payload_json: string; fetched_at: number }>(
        'SELECT payload_json, fetched_at FROM place_details_cache WHERE place_id = ? AND lang = ? AND expanded = ?',
        placeId,
        lang ?? '',
        CACHE_KIND,
      );
      if (!row) return null;
      const parsed = JSON.parse(row.payload_json) as CachePayload;
      if (parsed.v !== CACHE_VERSION) return null;

      // A cached candidate is only usable while its bytes are still on disk, and
      // the nightly sweep deletes every picture nobody picked — which is most of
      // them. Treat any loss as a stale entry and rebuild, rather than serving
      // the survivors: filtering alone would leave the column empty for the rest
      // of the week for a place that has pictures perfectly available.
      const checks = await Promise.all(parsed.photos.map((photo) => this.photoCache.get(photo.key)));
      const photos = parsed.photos.filter((_, i) => checks[i]);
      if (photos.length !== parsed.photos.length) return null;

      const value: CachedEnrichment = {
        photos,
        description: parsed.description ?? null,
        facts: parsed.facts ?? [],
        hours: parsed.hours ?? null,
        rating: parsed.rating ?? null,
      };
      // An answer keeps for a week; the absence of one gets ten minutes.
      const ttl = hasAnything(value) ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
      if (Date.now() - row.fetched_at >= ttl) return null;
      return value;
    } catch {
      return null;
    }
  }

  private writeCache(placeId: string, lang: string | undefined, value: CachedEnrichment): void {
    try {
      this.database.run(
        'INSERT OR REPLACE INTO place_details_cache (place_id, lang, expanded, payload_json, fetched_at) VALUES (?, ?, ?, ?, ?)',
        placeId,
        lang ?? '',
        CACHE_KIND,
        JSON.stringify({ ...value, v: CACHE_VERSION } satisfies CachePayload),
        Date.now(),
      );
    } catch (err) {
      console.error('Failed to cache place enrichment:', err);
    }
  }
}
