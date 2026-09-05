/**
 * ENRICH-070..082 — where a description comes from.
 *
 * The cases the column got wrong on dev1: L'Osteria Rostock, Hamburg Airport
 * and Berlin Brandenburg Airport all showed no description at all with a Google
 * key configured, and Berlin Hauptbahnhof showed none without one. Two distinct
 * causes, both pinned here — Google short-circuiting the free chain, and the
 * chain itself only ever starting from an OSM `wikipedia` tag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbGet, mockDbRun } = vi.hoisted(() => ({
  // The prepare() stub below forwards the SQL and then the bound values, so the
  // spy has to declare that shape. Inferred from a zero-arg implementation it
  // would reject the spread at the call site.
  mockDbGet: vi.fn((_sql: string, ..._params: unknown[]): unknown => undefined),
  mockDbRun: vi.fn(),
}));

vi.mock('../../../src/db/database', () => ({
  db: {
    prepare: (sql: string) => ({
      get: (...params: unknown[]) => mockDbGet(sql, ...params),
      run: (...params: unknown[]) => mockDbRun(sql, ...params),
      all: () => [],
    }),
  },
}));

vi.mock('../../../src/utils/ssrfGuard', () => ({
  safeFetchFollow: vi.fn(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })),
  checkSsrf: vi.fn(async () => ({ allowed: true })),
  SsrfBlockedError: class extends Error {},
}));

vi.mock('../../../src/config', () => ({ JWT_SECRET: 'test-secret', ENCRYPTION_KEY: '0'.repeat(64) }));

const { mockTrekPlacesById } = vi.hoisted(() => ({
  mockTrekPlacesById: vi.fn(async (_gers: string): Promise<unknown> => null),
}));
vi.mock('../../../src/nest/maps/trek-places.client', () => ({
  trekPlacesById: mockTrekPlacesById,
}));

import { db } from '../../../src/db/database';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { PlaceEnrichmentService } from '../../../src/nest/place-enrichment/place-enrichment.service';
import type { MapsService } from '../../../src/nest/maps/maps.service';
import type { PlacePhotoCacheService } from '../../../src/nest/place-photos/place-photo-cache.service';

const GOOGLE_REQ = { lat: 53.6323, lng: 10.0067, name: 'Hamburg Airport', placeId: 'ChIJham', lang: 'de' };
const OSM_REQ = { lat: 52.525, lng: 13.3694, name: 'Berlin Hauptbahnhof', placeId: 'relation:3600565', lang: 'de' };

const EXTRACT = {
  text: 'Der Berliner Hauptbahnhof ist der größte Kreuzungsbahnhof Europas.',
  sourceUrl: 'https://de.wikipedia.org/wiki/Berlin_Hauptbahnhof',
  source: 'wikipedia' as const,
};

function mapsStub(over: Partial<Record<keyof MapsService, unknown>> = {}) {
  return {
    getMapsKey: vi.fn(() => null as string | null),
    photosDisabled: vi.fn(() => false),
    detailsDisabled: vi.fn(() => false),
    fetchGooglePhotoRefs: vi.fn(async () => []),
    fetchGooglePhotoBytes: vi.fn(async () => null),
    fetchCommonsCandidates: vi.fn(async () => []),
    fetchCommonsCategoryCandidates: vi.fn(async () => []),
    fetchWikidataCandidates: vi.fn(async () => ({ candidates: [], commonsCategory: null })),
    fetchCommonsFilesByName: vi.fn(async () => new Map()),
    fetchWikiLeadImageName: vi.fn(async () => null),
    fetchEditorialSummary: vi.fn(async () => null as string | null),
    fetchWikiExtract: vi.fn(async () => null as typeof EXTRACT | null),
    fetchWikiExtractFor: vi.fn(async () => null as typeof EXTRACT | null),
    fetchWikidataSitelinks: vi.fn(async () => ({}) as Record<string, string>),
    resolveOsmIdentity: vi.fn(async () => null as { tags: Record<string, string>; osmUrl: string | null; matchedName: string } | null),
    details: vi.fn(async () => ({ place: null })),
    ...over,
  } as unknown as MapsService;
}

const cacheStub = () =>
  ({ get: vi.fn(() => null), put: vi.fn(async () => ({ photoUrl: '/x', filePath: '/x', attribution: null })) }) as unknown as PlacePhotoCacheService;

const make = (maps: MapsService) => new PlaceEnrichmentService(new DatabaseService(db as never), maps, cacheStub());

beforeEach(() => {
  mockDbGet.mockReset();
  mockDbGet.mockReturnValue(undefined);
  mockDbRun.mockReset();
  mockTrekPlacesById.mockReset();
  mockTrekPlacesById.mockResolvedValue(null);
});

describe('identity resolution', () => {
  it('ENRICH-070: looks up a Google place in OpenStreetMap, which is where its wiki tags live', async () => {
    // Google's payload has no wikidata, no wikipedia and no wikimedia_commons —
    // it never had. Before this, configuring an API key silently switched off
    // the free half of the column.
    const maps = mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      details: vi.fn(async () => ({ place: { source: 'google', name: 'Hamburg Airport' } })),
      resolveOsmIdentity: vi.fn(async () => ({
        tags: { wikidata: 'Q27706', wikipedia: 'de:Flughafen Hamburg' },
        osmUrl: 'https://www.openstreetmap.org/way/147122729',
        matchedName: 'Hamburg Airport',
      })),
      fetchWikidataSitelinks: vi.fn(async () => ({ dewikivoyage: 'Hamburg-Fuhlsbüttel' })),
      fetchWikiExtractFor: vi.fn(async () => ({ ...EXTRACT, source: 'wikivoyage' as const })),
    });

    const out = await make(maps).enrich(1, GOOGLE_REQ);

    expect(maps.resolveOsmIdentity).toHaveBeenCalledWith('Hamburg Airport', 53.6323, 10.0067, { lang: 'de' });
    expect(out.description).toMatchObject({ source: 'wikivoyage', license: 'CC BY-SA 4.0' });
  });

  it('ENRICH-071: does not spend a lookup when the payload already carries tags', async () => {
    const maps = mapsStub({
      details: vi.fn(async () => ({ place: { source: 'openstreetmap', wikidata: 'Q1097' } })),
      fetchWikidataSitelinks: vi.fn(async () => ({ dewiki: 'Berlin Hauptbahnhof' })),
      fetchWikiExtractFor: vi.fn(async () => EXTRACT),
    });

    await make(maps).enrich(1, OSM_REQ);

    expect(maps.resolveOsmIdentity).not.toHaveBeenCalled();
  });

  it('ENRICH-072: never writes OSM tags into a Google payload, but still shows them', async () => {
    // collectFacts and the OSM branch of collectDescription both gate on
    // details.source. Merging the looked-up tags in would either be dead weight
    // or would make a Google place claim to be an OpenStreetMap one.
    const details = { source: 'google', name: 'Hamburg Airport', summary: null };
    const maps = mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      details: vi.fn(async () => ({ place: details })),
      resolveOsmIdentity: vi.fn(async () => ({
        tags: { wikidata: 'Q27706', cuisine: 'german' },
        osmUrl: null,
        matchedName: 'Hamburg Airport',
      })),
    });

    const out = await make(maps).enrich(1, GOOGLE_REQ);

    // The point is that the provider's own record is never written into. Its
    // `source` is what collectFacts and the OSM branch of collectDescription
    // gate on, so a Google payload carrying OSM tags would either ignore them
    // or start claiming to be an OpenStreetMap place.
    expect(details).toEqual({ source: 'google', name: 'Hamburg Airport', summary: null });
    // The tags still reach the reader — through the second object, not by
    // mutating the first. Google has no concept of cuisine, so without this a
    // Google place showed a rating and nothing else.
    expect(out.facts.some((f) => f.kind === 'cuisine')).toBe(true);
  });
});

describe('description source order', () => {
  it('ENRICH-073: prefers a free article over Google, even with a key configured', async () => {
    // This is the whole point of the reordering: Google used to be asked first
    // and answered for almost nothing, so the column stayed empty while a
    // perfectly good article sat one call away.
    const maps = mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      details: vi.fn(async () => ({ place: { source: 'google', wikidata: 'Q1097' } })),
      fetchWikidataSitelinks: vi.fn(async () => ({ dewiki: 'Berlin Hauptbahnhof' })),
      fetchWikiExtractFor: vi.fn(async () => EXTRACT),
      fetchEditorialSummary: vi.fn(async () => 'A large railway station.'),
    });

    const out = await make(maps).enrich(1, { ...OSM_REQ, placeId: 'ChIJhbf' });

    expect(out.description).toMatchObject({ source: 'wikipedia' });
    // Not merely lower priority — the billed call is never made.
    expect(maps.fetchEditorialSummary).not.toHaveBeenCalled();
  });

  it('ENRICH-074: still falls back to Google when nothing free describes the place', async () => {
    const maps = mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      details: vi.fn(async () => ({ place: { source: 'google', google_maps_url: 'https://maps.google/x' } })),
      fetchEditorialSummary: vi.fn(async () => 'Casual chain for wood-fired pizza.'),
    });

    const out = await make(maps).enrich(1, { ...GOOGLE_REQ, name: "L'Osteria Rostock" });

    expect(out.description).toMatchObject({
      source: 'google',
      text: 'Casual chain for wood-fired pizza.',
      sourceUrl: 'https://maps.google/x',
      license: null,
    });
  });

  it('ENRICH-075: keeps the OpenStreetMap description ahead of everything', async () => {
    const maps = mapsStub({
      details: vi.fn(async () => ({
        place: { source: 'openstreetmap', summary: '  Ein Bahnhof.  ', osm_url: 'https://osm.org/r/1', wikidata: 'Q1097' },
      })),
      fetchWikiExtractFor: vi.fn(async () => EXTRACT),
    });

    const out = await make(maps).enrich(1, OSM_REQ);

    expect(out.description).toMatchObject({ text: 'Ein Bahnhof.', source: 'osm', license: 'ODbL 1.0' });
    expect(maps.fetchWikidataSitelinks).not.toHaveBeenCalled();
  });
});

describe('article language choice', () => {
  it('ENRICH-076: asks for the reader\'s language before English', async () => {
    const maps = mapsStub({
      details: vi.fn(async () => ({ place: { source: 'openstreetmap', wikidata: 'Q1097' } })),
      fetchWikidataSitelinks: vi.fn(async () => ({ dewiki: 'Berlin Hauptbahnhof', enwiki: 'Berlin Hauptbahnhof' })),
      fetchWikiExtractFor: vi.fn(async () => EXTRACT),
    });

    await make(maps).enrich(1, OSM_REQ);

    const sites = (maps.fetchWikidataSitelinks as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0][1];
    expect(sites.slice(0, 2)).toEqual(['dewikivoyage', 'dewiki']);
    expect(sites).toContain('enwiki');
    expect(maps.fetchWikiExtractFor).toHaveBeenCalledWith('wikipedia', 'de', 'Berlin Hauptbahnhof');
  });

  it('ENRICH-077: puts Wikivoyage ahead of Wikipedia in the same language', async () => {
    // Wikivoyage describes a place for somebody about to go there; Wikipedia
    // opens with area in square kilometres.
    const maps = mapsStub({
      details: vi.fn(async () => ({ place: { source: 'openstreetmap', wikidata: 'Q1097' } })),
      fetchWikidataSitelinks: vi.fn(async () => ({ dewikivoyage: 'Berlin', dewiki: 'Berlin Hauptbahnhof' })),
      fetchWikiExtractFor: vi.fn(async () => ({ ...EXTRACT, source: 'wikivoyage' as const })),
    });

    await make(maps).enrich(1, OSM_REQ);

    expect(maps.fetchWikiExtractFor).toHaveBeenNthCalledWith(1, 'wikivoyage', 'de', 'Berlin');
  });

  it('ENRICH-078: keeps the language the place itself named, ahead of English', async () => {
    // A Korean reader looking at the Brandenburg Gate: no kowiki sitelink, but
    // the OSM tag names a German article somebody curated for this place.
    const maps = mapsStub({
      details: vi.fn(async () => ({
        place: { source: 'openstreetmap', wikidata: 'Q82425', wikipedia: 'de:Brandenburger Tor' },
      })),
      fetchWikidataSitelinks: vi.fn(async () => ({ dewiki: 'Brandenburger Tor', enwiki: 'Brandenburg Gate' })),
      fetchWikiExtractFor: vi.fn(async () => EXTRACT),
    });

    await make(maps).enrich(1, { ...OSM_REQ, lang: 'ko' });

    const sites = (maps.fetchWikidataSitelinks as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0][1];
    expect(sites.indexOf('dewiki')).toBeLessThan(sites.indexOf('enwiki'));
  });

  it('ENRICH-079: falls back to the tag when the item has no usable sitelink', async () => {
    const maps = mapsStub({
      details: vi.fn(async () => ({
        place: { source: 'openstreetmap', wikidata: 'Q1', wikipedia: 'de:Museum Ludwig' },
      })),
      fetchWikidataSitelinks: vi.fn(async () => ({})),
      fetchWikiExtract: vi.fn(async () => EXTRACT),
    });

    const out = await make(maps).enrich(1, OSM_REQ);

    expect(maps.fetchWikiExtract).toHaveBeenCalledWith('de:Museum Ludwig');
    expect(out.description).toMatchObject({ source: 'wikipedia' });
  });

  it('ENRICH-080: tries the next site when one has no article', async () => {
    const maps = mapsStub({
      details: vi.fn(async () => ({ place: { source: 'openstreetmap', wikidata: 'Q1097' } })),
      fetchWikidataSitelinks: vi.fn(async () => ({ dewikivoyage: 'Nowhere', dewiki: 'Berlin Hauptbahnhof' })),
      fetchWikiExtractFor: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(EXTRACT),
    });

    const out = await make(maps).enrich(1, OSM_REQ);

    expect(maps.fetchWikiExtractFor).toHaveBeenCalledTimes(2);
    expect(out.description).toMatchObject({ source: 'wikipedia' });
  });
});

/**
 * ENRICH-097..100 — topping a Google place up from OpenStreetMap.
 *
 * Google's payload has no cuisine, no wheelchair access, no outdoor seating and
 * no menu link. It never had. So a Google place showed a rating and nothing
 * else, while the same building in OSM carried all of it — and the lookup that
 * finds its wiki tags brings those along at no extra cost.
 */
describe('filling Google gaps from the free sources', () => {
  const OSM_TAGS = {
    wikidata: 'Q1',
    cuisine: 'pizza;italian',
    wheelchair: 'limited',
    outdoor_seating: 'yes',
    'opening_hours': 'Mo-Su 11:30-23:00',
  };

  const googlePlaceAlsoInOsm = (over: Partial<Record<keyof MapsService, unknown>> = {}) =>
    mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      details: vi.fn(async () => ({ place: { source: 'google', rating: 4.6, rating_count: 4495 } })),
      resolveOsmIdentity: vi.fn(async () => ({ tags: OSM_TAGS, osmUrl: null, matchedName: "L'Osteria" })),
      ...over,
    });

  it('ENRICH-097: shows the OSM facts a Google place has no concept of', async () => {
    const out = await make(googlePlaceAlsoInOsm()).enrich(1, GOOGLE_REQ);

    const kinds = out.facts.map((f) => f.kind);
    expect(kinds).toContain('cuisine');
    expect(kinds).toContain('wheelchair');
    expect(kinds).toContain('outdoorSeating');
    // Semicolons and underscores are OSM syntax, not something to show a reader.
    expect(out.facts.find((f) => f.kind === 'cuisine')?.value).toBe('pizza, italian');
  });

  it('ENRICH-098: keeps the rating Google reported', async () => {
    const out = await make(googlePlaceAlsoInOsm()).enrich(1, GOOGLE_REQ);
    expect(out.rating).toEqual({ value: 4.6, count: 4495 });
  });

  it('ENRICH-099: takes opening hours from OSM when Google reported none', async () => {
    const out = await make(googlePlaceAlsoInOsm()).enrich(1, GOOGLE_REQ);
    expect(out.hours?.weekdayDescriptions[0]).toContain('11:30-23:00');
  });

  it('ENRICH-100: the provider wins where both know the same thing', async () => {
    // Google's hours are the ones the user searched against and the ones more
    // likely to be current for a business.
    const maps = googlePlaceAlsoInOsm({
      details: vi.fn(async () => ({
        place: { source: 'google', opening_hours: ['Monday: 09:00-17:00'], rating: 4.6, rating_count: 10 },
      })),
    });

    const out = await make(maps).enrich(1, GOOGLE_REQ);

    expect(out.hours?.weekdayDescriptions).toEqual(['Monday: 09:00-17:00']);
  });
})


describe("the description on the place's own website", () => {
  // The ordinary case, and the one nothing covered before: a restaurant has no
  // encyclopaedia article and never will, but it does publish a summary of
  // itself in JSON-LD for machines to read. 43 percent of Overture places carry
  // a website; a fraction of a percent carry a wiki tag.
  const GERS_REQ = {
    lat: 54.0879,
    lng: 12.1408,
    name: "L'Osteria",
    placeId: 'gers:abc-123',
    lang: 'de',
  };

  it('ENRICH-090: quotes the site and credits it by URL', async () => {
    mockTrekPlacesById.mockResolvedValue({
      description: { text: 'Pizza in Rostock, seit 2015.', sourceUrl: 'https://losteria.net/rostock' },
    });

    const out = await make(mapsStub()).enrich(1, GERS_REQ);

    expect(mockTrekPlacesById).toHaveBeenCalledWith('abc-123');
    expect(out.description).toEqual({
      text: 'Pizza in Rostock, seit 2015.',
      source: 'website',
      sourceUrl: 'https://losteria.net/rostock',
      // No licence claim: the operator published a summary for machines, they
      // did not grant terms. Naming and linking the source is what is owed.
      license: null,
    });
  });

  it('ENRICH-091: leaves the encyclopaedias ahead of it', async () => {
    // An article about this exact place, written by someone with no stake in
    // it, beats the operator's own copy. The website only fills the gap the
    // encyclopaedias leave, which is almost every business.
    mockTrekPlacesById.mockResolvedValue({ description: { text: 'Unser Restaurant.', sourceUrl: 'https://x.de' } });
    const maps = mapsStub({
      details: vi.fn(async () => ({ place: { source: 'openstreetmap', wikipedia: 'de:Irgendwas' } })),
      fetchWikiExtract: vi.fn(async () => EXTRACT),
    });

    const out = await make(maps).enrich(1, GERS_REQ);

    expect(out.description?.source).toBe('wikipedia');
  });

  it('ENRICH-092: asks only for places that came from the API', async () => {
    await make(mapsStub()).enrich(1, { ...GERS_REQ, placeId: 'ChIJsomethinggoogle' });
    expect(mockTrekPlacesById).not.toHaveBeenCalled();
  });

  it('ENRICH-093: a failing API costs the place nothing else', async () => {
    mockTrekPlacesById.mockRejectedValue(new Error('places api down'));
    const maps = mapsStub({
      details: vi.fn(async () => ({ place: { source: 'openstreetmap', name: "L'Osteria" } })),
    });

    await expect(make(maps).enrich(1, GERS_REQ)).resolves.toMatchObject({ description: null });
  });

  it('ENRICH-094: ignores an empty or whitespace-only summary', async () => {
    mockTrekPlacesById.mockResolvedValue({ description: { text: '   ', sourceUrl: 'https://x.de' } });
    const out = await make(mapsStub()).enrich(1, GERS_REQ);
    expect(out.description).toBeNull();
  });
});
