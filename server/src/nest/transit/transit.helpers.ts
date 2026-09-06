/**
 * Pure transit helpers shared by TransitService and the itinerary
 * validation/reservation builders in transit-itinerary.helpers.ts. Kept as
 * plain functions/consts (the maps.helpers.ts / files.constants.ts
 * precedent) — helpers never block a migration.
 */

// Modes the client may request — a strict whitelist so the proxy can't be used
// to smuggle arbitrary query values upstream. TRANSIT covers everything; the
// others let the user filter (RAIL already includes subway/suburban etc.).
export const SCHEDULED_TRANSIT_MODES = [
  'BUS',
  'COACH',
  'TRAM',
  'SUBWAY',
  'RAIL',
  'FERRY',
  'FUNICULAR',
  'AERIAL_LIFT',
  // Fine-grained rail modes so "train without subway" is expressible (RAIL
  // itself includes SUBWAY per the MOTIS mode taxonomy).
  'HIGHSPEED_RAIL',
  'LONG_DISTANCE',
  'NIGHT_RAIL',
  'REGIONAL_RAIL',
  'SUBURBAN',
] as const;

export interface TransitPlace {
  name: string;
  lat: number;
  lng: number;
  type: string;
  area: string | null;
}

export interface TransitLegStop {
  name: string;
  lat: number;
  lng: number;
  time: string | null;
  scheduledTime: string | null;
  track: string | null;
}

export interface TransitLeg {
  mode: string;
  from: TransitLegStop;
  to: TransitLegStop;
  duration: number;
  distance: number | null;
  headsign: string | null;
  line: string | null;
  lineColor: string | null;
  lineTextColor: string | null;
  agency: string | null;
  intermediateStops: number;
  /** Encoded polyline of the leg's real path (Google encoding) + its precision. */
  geometry: string | null;
  geometryPrecision: number;
}

export interface TransitItinerary {
  startTime: string;
  endTime: string;
  duration: number;
  transfers: number;
  walkSeconds: number;
  legs: TransitLeg[];
}

export interface PlanQuery {
  from: string;
  to: string;
  time?: string;
  arriveBy?: boolean;
  modes?: string;
  maxTransfers?: number;
}

export function deriveTransitStats(
  startTime: string,
  endTime: string,
  legs: TransitLeg[],
  reportedTransfers?: number,
): Pick<TransitItinerary, 'duration' | 'transfers' | 'walkSeconds'> {
  // Number.isFinite, not bare Math.max: an unparseable provider timestamp
  // yields NaN, which Math.max passes through and JSON.stringify turns into
  // null — report 0 instead of a null duration.
  const wallClock = Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000);
  return {
    duration: Number.isFinite(wallClock) ? Math.max(0, wallClock) : 0,
    transfers:
      typeof reportedTransfers === 'number'
        ? reportedTransfers
        : Math.max(0, legs.filter((leg) => leg.mode !== 'WALK').length - 1),
    walkSeconds: legs.filter((leg) => leg.mode === 'WALK').reduce((total, leg) => total + leg.duration, 0),
  };
}

/**
 * Google-encoded polyline codec.
 *
 * The client carries its own decoder for drawing a journey on the map
 * (client/src/components/Map/transitGeometry.ts). This pair exists for a
 * different job the client never has: the Google backend receives a walk split
 * across several navigation steps, each with its own polyline, and has to
 * MERGE them into the single walk leg the rest of TREK expects — which needs an
 * encoder to put the joined path back on the wire.
 */
export function decodePolyline(encoded: string, precision: number): [number, number][] {
  const factor = 10 ** precision;
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1] as const) {
      let result = 0;
      let shift = 0;
      let byte = 0x20;
      while (byte >= 0x20) {
        if (index >= encoded.length) return points;
        byte = (encoded.codePointAt(index++) ?? 0) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      }
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    points.push([lat / factor, lng / factor]);
  }
  return points;
}

function encodeSigned(value: number): string {
  let remaining = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (remaining >= 0x20) {
    out += String.fromCharCode((0x20 | (remaining & 0x1f)) + 63);
    remaining >>= 5;
  }
  return out + String.fromCharCode(remaining + 63);
}

export function encodePolyline(points: [number, number][], precision: number): string {
  const factor = 10 ** precision;
  let out = '';
  let lastLat = 0;
  let lastLng = 0;
  for (const [lat, lng] of points) {
    const scaledLat = Math.round(lat * factor);
    const scaledLng = Math.round(lng * factor);
    out += encodeSigned(scaledLat - lastLat) + encodeSigned(scaledLng - lastLng);
    lastLat = scaledLat;
    lastLng = scaledLng;
  }
  return out;
}
