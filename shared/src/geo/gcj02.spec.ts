import { fromAmapLocation, gcj02ToWgs84, isOutsideChina, toAmapLocation, wgs84ToGcj02 } from './gcj02';

import { describe, expect, it } from 'vitest';

/** Metres between two coordinates — good enough for an assertion at this scale. */
function metresApart(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const mLat = ((aLat + bLat) / 2) * (Math.PI / 180);
  const x = dLng * Math.cos(mLat);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

describe('isOutsideChina', () => {
  it('covers the mainland, Hong Kong and Taiwan', () => {
    expect(isOutsideChina(39.9042, 116.4074)).toBe(false); // Beijing
    expect(isOutsideChina(22.3193, 114.1694)).toBe(false); // Hong Kong
    expect(isOutsideChina(25.033, 121.5654)).toBe(false); // Taipei
  });

  it('excludes the rest of the world so a foreign trip is never shifted', () => {
    expect(isOutsideChina(48.8566, 2.3522)).toBe(true); // Paris
    expect(isOutsideChina(35.6762, 139.6503)).toBe(true); // Tokyo
    expect(isOutsideChina(-33.8688, 151.2093)).toBe(true); // Sydney
  });

  it('treats a non-finite coordinate as outside rather than shifting NaN', () => {
    expect(isOutsideChina(Number.NaN, 116)).toBe(true);
    expect(isOutsideChina(39, Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe('wgs84ToGcj02', () => {
  // Reference values from the published approximation every coordtransform
  // implementation shares; the tolerance is the metre-or-two the algorithm is
  // accurate to, not a precision claim about our arithmetic.
  it('shifts Tiananmen Square by the expected few hundred metres', () => {
    const gcj = wgs84ToGcj02(39.90869, 116.39124);
    expect(gcj.lat).toBeCloseTo(39.91009, 4);
    expect(gcj.lng).toBeCloseTo(116.39745, 4);
    // The whole point of the datum: the offset is big enough to be visibly wrong
    // on a map if it were skipped.
    expect(metresApart(39.90869, 116.39124, gcj.lat, gcj.lng)).toBeGreaterThan(300);
  });

  it('leaves a coordinate outside China exactly as it came in', () => {
    const paris = wgs84ToGcj02(48.8566, 2.3522);
    expect(paris).toEqual({ lat: 48.8566, lng: 2.3522 });
  });
});

describe('gcj02ToWgs84', () => {
  it('round-trips to sub-metre accuracy across China', () => {
    const points: [number, number][] = [
      [39.90869, 116.39124], // Beijing
      [31.2304, 121.4737], // Shanghai
      [22.5431, 114.0579], // Shenzhen
      [29.6534, 91.1719], // Lhasa — far west, where the offset is largest
      [43.8256, 87.6168], // Ürümqi
      [18.2528, 109.5119], // Sanya — far south
    ];
    for (const [lat, lng] of points) {
      const gcj = wgs84ToGcj02(lat, lng);
      const back = gcj02ToWgs84(gcj.lat, gcj.lng);
      expect(metresApart(lat, lng, back.lat, back.lng)).toBeLessThan(1);
    }
  });

  it('is the exact inverse, not the subtract-the-same-offset shortcut', () => {
    // The shortcut is out by a few metres; this asserts we are well inside that.
    const gcj = wgs84ToGcj02(39.90869, 116.39124);
    const back = gcj02ToWgs84(gcj.lat, gcj.lng);
    expect(back.lat).toBeCloseTo(39.90869, 7);
    expect(back.lng).toBeCloseTo(116.39124, 7);
  });

  it('leaves a coordinate outside China alone', () => {
    expect(gcj02ToWgs84(35.6762, 139.6503)).toEqual({ lat: 35.6762, lng: 139.6503 });
  });
});

describe('toAmapLocation', () => {
  it('emits lng,lat in GCJ-02 with six decimals', () => {
    expect(toAmapLocation(39.90869, 116.39124)).toBe('116.397481,39.910091');
  });
});

describe('fromAmapLocation', () => {
  it('parses lng,lat back into WGS-84', () => {
    const parsed = fromAmapLocation('116.397481,39.910091');
    expect(parsed).not.toBeNull();
    expect(metresApart(39.90869, 116.39124, parsed!.lat, parsed!.lng)).toBeLessThan(1);
  });

  it('returns null for the shapes Amap actually sends for a POI with no geometry', () => {
    expect(fromAmapLocation([])).toBeNull();
    expect(fromAmapLocation('')).toBeNull();
    expect(fromAmapLocation(undefined)).toBeNull();
    expect(fromAmapLocation('116.397481')).toBeNull();
    expect(fromAmapLocation('nope,nope')).toBeNull();
  });
});
