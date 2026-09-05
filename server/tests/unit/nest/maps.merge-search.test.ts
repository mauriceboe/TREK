/**
 * MAPS-MERGE-001..008 — showing the index's answer and OpenStreetMap's together.
 *
 * Why this exists, in numbers. 128 places out of a real trip to Japan, all
 * saved through the old search, replayed against the index: 51.6 percent came
 * back inside the top five. For most of the rest the index returned the shops
 * AROUND the landmark instead of nothing, which is worse than nothing, because
 * ten plausible wrong answers look like an answer and the user never learns the
 * temple was one query away in OpenStreetMap.
 */
import { describe, it, expect } from 'vitest';
import { mergeSearchResults } from '../../../src/nest/maps/maps.helpers';

const p = (name: string, lat: number, lng: number, source: string) => ({
  name,
  lat,
  lng,
  source,
  osm_id: `${source}:${name}`,
});

describe('mergeSearchResults', () => {
  it('MAPS-MERGE-001: lifts the landmark above the shops that surround it', () => {
    // The Hase-dera case. The index has the coffee shop next door and not the
    // temple; OpenStreetMap has the temple.
    const index = [p('Uni Coffee Roastery', 35.3128, 139.534, 'trek-places')];
    const osm = [p('Hase-dera', 35.3125, 139.5335, 'openstreetmap')];
    const out = mergeSearchResults(index, osm, 'Hase-dera');
    expect(out.map((r) => r.name)).toEqual(['Hase-dera', 'Uni Coffee Roastery']);
  });

  it('MAPS-MERGE-002: leaves a good index match at the top', () => {
    const index = [p("L'Osteria Rostock", 54.0879, 12.1408, 'trek-places')];
    const osm = [p('Osteria Steinstrasse', 54.09, 12.15, 'openstreetmap')];
    const out = mergeSearchResults(index, osm, "L'Osteria");
    expect(out[0].name).toBe("L'Osteria Rostock");
  });

  it('MAPS-MERGE-003: keeps one copy of a place both sources know', () => {
    // The index's copy, because that is the one carrying a stable id, contact
    // details and hours.
    const index = [p("L'Osteria", 54.0879, 12.1408, 'trek-places')];
    const osm = [p("L'Osteria", 54.08792, 12.14082, 'openstreetmap')];
    const out = mergeSearchResults(index, osm, "L'Osteria");
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('trek-places');
  });

  it('MAPS-MERGE-004: two neighbouring shops both survive', () => {
    // 60 m is the dedupe distance: close enough to be one shop, far enough
    // apart that the bakery beside it is still its own result.
    const index = [p('Bakery A', 54.0879, 12.1408, 'trek-places')];
    const osm = [p('Bakery B', 54.0889, 12.1408, 'openstreetmap')];
    expect(mergeSearchResults(index, osm, 'Bakery')).toHaveLength(2);
  });

  it('MAPS-MERGE-005: a source that answered nothing changes nothing', () => {
    const index = [p("L'Osteria", 54.0879, 12.1408, 'trek-places')];
    expect(mergeSearchResults(index, [], "L'Osteria")).toEqual(index);
    expect(mergeSearchResults([], index, "L'Osteria")).toEqual(index);
  });

  it('MAPS-MERGE-006: name matches come first, index before OpenStreetMap', () => {
    const index = [p('Something Else', 1, 1, 'trek-places'), p('Kegon Falls', 1.5, 1.5, 'trek-places')];
    const osm = [p('Kegon Waterfall', 2, 2, 'openstreetmap'), p('Unrelated', 3, 3, 'openstreetmap')];
    expect(mergeSearchResults(index, osm, 'Kegon Falls').map((r) => r.name)).toEqual([
      'Kegon Falls',
      'Kegon Waterfall',
      'Something Else',
      'Unrelated',
    ]);
  });

  it('MAPS-MERGE-007: honours the cap', () => {
    const many = Array.from({ length: 12 }, (_, i) => p(`Place ${i}`, 50 + i, 10 + i, 'trek-places'));
    expect(mergeSearchResults(many, many, 'Place', 10)).toHaveLength(10);
  });

  it('MAPS-MERGE-008: a result without coordinates is kept, not deduped away', () => {
    // Nominatim occasionally answers with an unparseable coordinate. Dropping
    // the row would lose a result; treating it as "not near anything" keeps it.
    const index = [p('A', 54, 12, 'trek-places')];
    const osm = [{ name: 'B', lat: null, lng: null, source: 'openstreetmap' }];
    expect(mergeSearchResults(index, osm, 'A')).toHaveLength(2);
  });
});
