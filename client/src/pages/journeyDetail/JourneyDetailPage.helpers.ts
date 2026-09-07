import { GeoOnceError } from '../../hooks/useGeolocation';
import type { JourneyEntry } from '../../store/journeyStore';
import { GRADIENTS } from './JourneyDetailPage.constants';

// Shared by the desktop entry editor and the mobile entry sheet so a failed
// one-shot position fix surfaces the same translated message everywhere.
export function geoOnceErrorKey(err: unknown): string {
  const code = err instanceof GeoOnceError ? err.code : 'unavailable';
  return code === 'permission-denied'
    ? 'journey.editor.locationPermissionDenied'
    : code === 'timeout'
      ? 'journey.editor.locationTimeout'
      : code === 'insecure-context'
        ? 'journey.editor.locationInsecureContext'
        : 'journey.editor.locationUnavailable';
}

export function pickGradient(id: number): string {
  return GRADIENTS[id % GRADIENTS.length];
}

export function groupByDate(entries: JourneyEntry[]): Map<string, JourneyEntry[]> {
  const groups = new Map<string, JourneyEntry[]>();
  for (const e of entries) {
    const d = e.entry_date;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push(e);
  }
  return groups;
}

export function createDraftJourneyEntry(journeyId: number, now = new Date()): JourneyEntry {
  const entryDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const entryTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return {
    id: 0,
    journey_id: journeyId,
    author_id: 0,
    type: 'entry',
    entry_date: entryDate,
    entry_time: entryTime,
    visibility: 'private',
    sort_order: 0,
    photos: [],
    created_at: 0,
    updated_at: 0,
  };
}

export function formatDate(d: string, locale?: string): { weekday: string; month: string; day: number } {
  const date = new Date(d + 'T00:00:00');
  // Pass the app's selected locale so weekday/month follow the UI language
  // instead of the browser's navigator.language.
  return {
    weekday: date.toLocaleDateString(locale, { weekday: 'long' }),
    month: date.toLocaleDateString(locale, { month: 'long' }),
    day: date.getDate(),
  };
}

export function photoUrl(p: { photo_id: number }, size: 'thumbnail' | 'original' = 'thumbnail'): string {
  return `/api/photos/${p.photo_id}/${size}`;
}

export function groupPhotosByDate(photos: any[]): { date: string; label: string; assets: any[] }[] {
  const map = new Map<string, any[]>();
  for (const asset of photos) {
    const key = asset.takenAt ? asset.takenAt.slice(0, 10) : '__unknown__';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(asset);
  }
  // Group order must not depend on the order of `photos`. Once the caller sorts by
  // distance to the entry, first-seen order would put the day holding the nearest
  // photo first and the date headings would stop reading chronologically. Order
  // within a day is left as handed in, so the distance sort still applies there.
  return [...map.entries()]
    .sort((a, b) => {
      if (a[0] === '__unknown__') return 1;
      if (b[0] === '__unknown__') return -1;
      return b[0].localeCompare(a[0]);
    })
    .map(([date, assets]) => ({
      date,
      label:
        date === '__unknown__'
          ? 'Unknown date'
          : new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            }),
      assets,
    }));
}

export interface ProviderPhotoAsset {
  id: string;
  takenAt?: string | null;
  lat?: number | null;
  lng?: number | null;
  [key: string]: unknown;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export function isValidGeoPoint(point: Partial<GeoPoint> | null | undefined): point is GeoPoint {
  return (
    !!point &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lng >= -180 &&
    point.lng <= 180
  );
}

/** Return the great-circle distance in metres between two coordinates. */
export function distanceBetweenGeoPoints(a: GeoPoint, b: GeoPoint): number {
  const earthRadius = 6371000;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const latA = toRadians(a.lat);
  const latB = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(Math.min(1, h)));
}

/**
 * Keep every asset, but put assets with usable GPS nearest to the selected
 * Journey location. Without a usable location, fall back to newest-taken-first
 * (provider search order isn't guaranteed chronological), with a stable index
 * tiebreak so photos missing `takenAt` keep a deterministic relative order.
 */
export function sortProviderPhotos<T extends ProviderPhotoAsset>(photos: T[], location?: GeoPoint | null): T[] {
  if (!isValidGeoPoint(location)) {
    return photos
      .map((photo, index) => ({ photo, index }))
      .sort((a, b) => {
        const at = a.photo.takenAt;
        const bt = b.photo.takenAt;
        if (!at && !bt) return a.index - b.index;
        if (!at) return 1;
        if (!bt) return -1;
        return bt.localeCompare(at) || a.index - b.index;
      })
      .map((item) => item.photo);
  }

  return photos
    .map((photo, index) => ({
      photo,
      index,
      distance: isValidGeoPoint({ lat: photo.lat ?? Number.NaN, lng: photo.lng ?? Number.NaN })
        ? distanceBetweenGeoPoints(location, { lat: photo.lat!, lng: photo.lng! })
        : null,
    }))
    .sort((a, b) => {
      if (a.distance === null && b.distance === null) return a.index - b.index;
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      return a.distance - b.distance || a.index - b.index;
    })
    .map((item) => item.photo);
}
