import https from 'https';
import fetch from 'node-fetch';

// Force IPv4 to avoid ETIMEDOUT on Docker bridge networks where IPv6 cannot route
export const ipv4Agent = new https.Agent({ family: 4 });

export const OSRM_API_URL = (process.env.OSRM_API_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');

// Timeouts
export const OSRM_TIMEOUT_MS = 15000;

// Speed cap constants
const SPEED_CAP_MIN_THRESHOLD = 0.1; // m/s — below this, treat as near-zero speed

// Rate limiter
let lastOsrmRequest = 0;
const OSRM_MIN_INTERVAL_MS = 1000;

export interface RouteDirection {
  instruction: string;
  distance_meters: number;
  duration_seconds: number;
  maneuver: string;
  road_name: string;
}

export interface OsrmRouteResult {
  geometry: string;
  distance_meters: number;
  duration_seconds: number;
  osrm_duration_seconds: number;
  speed_capped: boolean;
  max_speed_ms: number | null;
  directions: RouteDirection[];
  annotations: { speed: number[]; distance: number[] };
}

export interface OsrmRoute {
  geometry: string;
  distance: number;
  duration: number;
  legs?: OsrmRouteLeg[];
}

export interface OsrmRouteLeg {
  annotation?: {
    speed?: number[];
    distance?: number[];
  };
  steps?: OsrmStep[];
}

export interface OsrmStep {
  maneuver?: { type?: string; modifier?: string };
  name?: string;
  distance?: number;
  duration?: number;
}

export interface OsrmResponse {
  code: string;
  routes?: OsrmRoute[];
}

export function calculateSpeedCappedDuration(
  annotations: { speed: number[]; distance: number[] },
  maxSpeedMs: number
): number {
  let totalDuration = 0;
  for (let i = 0; i < annotations.speed.length; i++) {
    const segSpeed = annotations.speed[i];
    const segDist = annotations.distance[i];
    const effectiveSpeed = (segSpeed < SPEED_CAP_MIN_THRESHOLD) ? segSpeed : Math.min(segSpeed, maxSpeedMs);
    if (effectiveSpeed < SPEED_CAP_MIN_THRESHOLD) {
      totalDuration += segSpeed > 0 ? segDist / segSpeed : 0;
    } else {
      totalDuration += segDist / effectiveSpeed;
    }
  }
  return Math.round(totalDuration);
}

function buildInstruction(maneuverType: string, modifier: string | undefined, roadName: string): string {
  const onto = roadName ? ` onto ${roadName}` : '';
  switch (maneuverType) {
    case 'depart':
      return modifier ? `Head ${modifier}${roadName ? ' on ' + roadName : ''}` : `Head${roadName ? ' on ' + roadName : ''}`;
    case 'arrive':
      return 'Arrive at destination';
    case 'turn':
      if (modifier === 'right' || modifier === 'sharp right' || modifier === 'slight right') return `Turn right${onto}`;
      if (modifier === 'left' || modifier === 'sharp left' || modifier === 'slight left') return `Turn left${onto}`;
      return `Turn${onto}`;
    case 'new name':
      return `Continue${onto}`;
    case 'merge':
      return `Merge${onto}`;
    case 'on ramp':
      return `Take the on-ramp${onto}`;
    case 'off ramp':
      return `Take exit${onto}`;
    case 'roundabout':
    case 'rotary':
      return `At the roundabout, take exit${onto}`;
    case 'fork':
      if (modifier === 'right' || modifier === 'slight right') return `Keep right${onto}`;
      if (modifier === 'left' || modifier === 'slight left') return `Keep left${onto}`;
      return `Keep${onto}`;
    case 'end of road':
      if (modifier === 'right' || modifier === 'slight right' || modifier === 'sharp right') return `Turn right${onto}`;
      if (modifier === 'left' || modifier === 'slight left' || modifier === 'sharp left') return `Turn left${onto}`;
      return `Turn${onto}`;
    default:
      return `Continue${onto}`;
  }
}

const MAJOR_MANEUVERS = new Set(['turn', 'new name', 'merge', 'on ramp', 'off ramp', 'fork', 'end of road', 'roundabout', 'rotary', 'depart', 'arrive']);
const MIN_DIRECTION_DISTANCE = 500; // meters — skip segments shorter than this

export function extractDirections(steps: OsrmStep[]): RouteDirection[] {
  if (!steps || steps.length === 0) return [];
  const directions: RouteDirection[] = [];
  let prevName = '';
  for (const step of steps) {
    const maneuver = step.maneuver || {};
    const type: string = maneuver.type || '';
    const modifier: string | undefined = maneuver.modifier;
    const roadName: string = step.name || '';
    const distance: number = step.distance || 0;
    const duration: number = step.duration || 0;

    if (distance <= MIN_DIRECTION_DISTANCE && type !== 'depart' && type !== 'arrive') continue;

    if (type === 'continue' || (modifier === 'straight' && type !== 'new name')) {
      if (roadName === prevName || !roadName) {
        prevName = roadName || prevName;
        continue;
      }
    }

    if (!MAJOR_MANEUVERS.has(type) && type !== 'continue') {
      prevName = roadName || prevName;
      continue;
    }

    directions.push({
      instruction: buildInstruction(type, modifier, roadName),
      distance_meters: distance,
      duration_seconds: duration,
      maneuver: type,
      road_name: roadName,
    });
    prevName = roadName || prevName;
  }
  return directions;
}

/** Decode Google-encoded polyline into [lat, lng] pairs */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, byte: number;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

/** Haversine distance in meters */
export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Perpendicular distance from a point to a line segment A->B, in meters */
function distanceToSegment(pLat: number, pLng: number, aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dAB = haversineDistance(aLat, aLng, bLat, bLng);
  if (dAB < 1) return haversineDistance(pLat, pLng, aLat, aLng);

  const toRad = Math.PI / 180;
  const cosLat = Math.cos(aLat * toRad);
  const dx = (bLng - aLng) * toRad * cosLat;
  const dy = (bLat - aLat) * toRad;
  const px = (pLng - aLng) * toRad * cosLat;
  const py = (pLat - aLat) * toRad;

  const dot = px * dx + py * dy;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, dot / lenSq)) : 0;

  const closestLat = aLat + t * (bLat - aLat);
  const closestLng = aLng + t * (bLng - aLng);
  return haversineDistance(pLat, pLng, closestLat, closestLng);
}

/** Minimum distance from a point to any segment of a polyline, in meters */
export function distanceToPolyline(pointLat: number, pointLng: number, polylineCoords: [number, number][]): number {
  let minDist = Infinity;
  for (let i = 0; i < polylineCoords.length - 1; i++) {
    const d = distanceToSegment(
      pointLat, pointLng,
      polylineCoords[i][0], polylineCoords[i][1],
      polylineCoords[i + 1][0], polylineCoords[i + 1][1]
    );
    if (d < minDist) minDist = d;
    if (d < 10) break; // close enough
  }
  return minDist;
}

export async function enforceOsrmRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastOsrmRequest;
  if (elapsed < OSRM_MIN_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, OSRM_MIN_INTERVAL_MS - elapsed));
  }
  lastOsrmRequest = Date.now();
}

export async function fetchOsrmRoute(
  fromLng: number, fromLat: number, toLng: number, toLat: number
): Promise<OsrmResponse> {
  await enforceOsrmRateLimit();

  const url = `${OSRM_API_URL}/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=polyline&steps=true&annotations=speed,distance`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);
  try {
    const response = await fetch(url, { agent: ipv4Agent, signal: controller.signal as never });
    clearTimeout(timeout);
    if (!response.ok) {
      console.error(`OSRM request failed: ${response.status} ${response.statusText} — URL: ${url}`);
      throw new Error(`OSRM request failed: ${response.status}`);
    }
    const data = await response.json() as OsrmResponse;
    return data;
  } catch (err: unknown) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`OSRM request timed out after ${OSRM_TIMEOUT_MS}ms — URL: ${url}`);
      throw new Error('OSRM request timed out');
    }
    throw err;
  }
}

export function isValidLatitude(lat: number): boolean {
  return typeof lat === 'number' && !isNaN(lat) && lat >= -90 && lat <= 90;
}

export function isValidLongitude(lng: number): boolean {
  return typeof lng === 'number' && !isNaN(lng) && lng >= -180 && lng <= 180;
}
