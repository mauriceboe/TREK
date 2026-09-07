import { describe, expect, it } from 'vitest';
import { distanceBetweenGeoPoints, groupPhotosByDate, sortProviderPhotos } from './JourneyDetailPage.helpers';

describe('Journey provider photo ranking', () => {
  it('places GPS photos nearest the selected Journey location and keeps photos without GPS', () => {
    const photos = [
      { id: 'far', lat: 41.95, lng: 12.5 },
      { id: 'unknown', lat: null, lng: null },
      { id: 'near', lat: 41.901, lng: 12.501 },
    ];

    expect(sortProviderPhotos(photos, { lat: 41.9, lng: 12.5 }).map((photo) => photo.id)).toEqual([
      'near',
      'far',
      'unknown',
    ]);
  });

  it('falls back to newest-taken-first when the selected entry has no valid location', () => {
    const photos = [
      { id: 'older', takenAt: '2026-03-14T09:00:00Z' },
      { id: 'newer', takenAt: '2026-03-16T09:00:00Z' },
    ];
    expect(sortProviderPhotos(photos, { lat: 200, lng: 12 }).map((photo) => photo.id)).toEqual(['newer', 'older']);
  });

  it('keeps original relative order for photos without a valid location and without takenAt', () => {
    const photos = [{ id: 'first' }, { id: 'second' }];
    expect(sortProviderPhotos(photos, { lat: 200, lng: 12 }).map((photo) => photo.id)).toEqual(['first', 'second']);
  });

  it('calculates a zero distance for identical coordinates', () => {
    expect(distanceBetweenGeoPoints({ lat: 41.9, lng: 12.5 }, { lat: 41.9, lng: 12.5 })).toBe(0);
  });
});

describe('Journey provider photo grouping', () => {
  it('orders the date headings newest first, whatever order the photos arrive in', () => {
    const photos = [
      { id: 'b', takenAt: '2026-03-14T09:00:00Z' },
      { id: 'a', takenAt: '2026-03-16T09:00:00Z' },
      { id: 'c', takenAt: '2026-03-15T09:00:00Z' },
    ];
    expect(groupPhotosByDate(photos).map((g) => g.date)).toEqual(['2026-03-16', '2026-03-15', '2026-03-14']);
  });

  it('keeps the distance sort inside a day but not across days', () => {
    // What sortProviderPhotos hands over: nearest first, so the 14th leads the list.
    const sorted = [
      { id: 'near', takenAt: '2026-03-14T10:00:00Z' },
      { id: 'mid', takenAt: '2026-03-16T10:00:00Z' },
      { id: 'far', takenAt: '2026-03-14T11:00:00Z' },
    ];
    const groups = groupPhotosByDate(sorted);
    expect(groups.map((g) => g.date)).toEqual(['2026-03-16', '2026-03-14']);
    expect(groups[1].assets.map((a: { id: string }) => a.id)).toEqual(['near', 'far']);
  });

  it('sorts photos without a date to the end', () => {
    const photos = [{ id: 'x' }, { id: 'y', takenAt: '2026-03-16T09:00:00Z' }];
    expect(groupPhotosByDate(photos).map((g) => g.date)).toEqual(['2026-03-16', '__unknown__']);
  });
});
