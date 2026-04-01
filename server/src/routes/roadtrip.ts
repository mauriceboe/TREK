import express, { Request, Response } from 'express';
import https from 'https';
import fetch from 'node-fetch';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { AuthRequest, Addon } from '../types';

// Force IPv4 to avoid ETIMEDOUT on Docker bridge networks where IPv6 cannot route
const ipv4Agent = new https.Agent({ family: 4 });

const router = express.Router({ mergeParams: true });

const OSRM_API_URL = (process.env.OSRM_API_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');

// Simple rate limiters
let lastOsrmRequest = 0;


function isRoadtripEnabled(): boolean {
  const addon = db.prepare('SELECT enabled FROM addons WHERE id = ?').get('roadtrip') as Pick<Addon, 'enabled'> | undefined;
  return !!addon?.enabled;
}

function requireAddon(_req: Request, res: Response, next: () => void): void {
  if (!isRoadtripEnabled()) {
    res.status(403).json({ error: 'Road Trip addon is not enabled' });
    return;
  }
  next();
}

function verifyTripAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

function getUserSetting(userId: number, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, key) as { value: string } | undefined;
  return row?.value || null;
}

function calculateFuelCost(distanceMeters: number, userId: number, tripId?: string | number): number | null {
  const unitSystem = getUserSetting(userId, 'roadtrip_unit_system') || 'metric';
  const fuelConsumption = getUserSetting(userId, 'roadtrip_fuel_consumption');

  // Check per-trip fuel price override first
  let fuelPrice: string | null = null;
  if (tripId) {
    const trip = db.prepare('SELECT roadtrip_fuel_price FROM trips WHERE id = ?').get(tripId) as { roadtrip_fuel_price: string | null } | undefined;
    if (trip?.roadtrip_fuel_price) fuelPrice = trip.roadtrip_fuel_price;
  }
  if (!fuelPrice) fuelPrice = getUserSetting(userId, 'roadtrip_fuel_price');

  if (!fuelPrice || !fuelConsumption) return null;
  const price = parseFloat(fuelPrice);
  const consumption = parseFloat(fuelConsumption);
  if (!price || !consumption) return null;

  if (unitSystem === 'imperial') {
    // MPG: cost = (distance_miles / mpg) * price_per_gallon
    const distanceMiles = distanceMeters / 1609.344;
    return Math.round((distanceMiles / consumption) * price * 100) / 100;
  }
  // Metric: L/100km: cost = (distance_km / 100) * consumption * price_per_litre
  const distanceKm = distanceMeters / 1000;
  return Math.round((distanceKm / 100) * consumption * price * 100) / 100;
}

function calculateSpeedCappedDuration(
  annotations: { speed: number[]; distance: number[] },
  maxSpeedMs: number
): number {
  let totalDuration = 0;
  for (let i = 0; i < annotations.speed.length; i++) {
    const segSpeed = annotations.speed[i];
    const segDist = annotations.distance[i];
    const effectiveSpeed = (segSpeed < 0.1) ? segSpeed : Math.min(segSpeed, maxSpeedMs);
    if (effectiveSpeed < 0.1) {
      // Use raw segment time: dist / original speed, or 0 if speed is ~0
      totalDuration += segSpeed > 0 ? segDist / segSpeed : 0;
    } else {
      totalDuration += segDist / effectiveSpeed;
    }
  }
  return Math.round(totalDuration);
}

function getMaxSpeedMs(userId: number): number | null {
  const maxSpeed = getUserSetting(userId, 'roadtrip_max_speed');
  if (!maxSpeed) return null;
  const speed = parseFloat(maxSpeed);
  if (!speed || speed <= 0) return null;
  const unitSystem = getUserSetting(userId, 'roadtrip_unit_system') || 'metric';
  return unitSystem === 'imperial' ? speed * 0.44704 : speed / 3.6;
}

interface RouteDirection {
  instruction: string;
  distance_meters: number;
  duration_seconds: number;
  maneuver: string;
  road_name: string;
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

function extractDirections(steps: any[]): RouteDirection[] {
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

    // Skip tiny segments
    if (distance <= 500 && type !== 'depart' && type !== 'arrive') continue;

    // Skip continue/straight unless road name changed
    if (type === 'continue' || (modifier === 'straight' && type !== 'new name')) {
      if (roadName === prevName || !roadName) {
        prevName = roadName || prevName;
        continue;
      }
    }

    // Only keep major maneuvers (plus continue that passed the road-name-change check)
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

const AUTO_FUEL_MARKER = '[auto-fuel]';

function syncFuelBudget(tripId: string | number, userId: number): void {
  // Check if user dismissed auto-fuel for this trip
  const dismissed = getUserSetting(userId, `roadtrip_fuel_budget_dismissed_${tripId}`);
  if (dismissed === 'true') return;

  // Sum all fuel costs for this trip
  const row = db.prepare(
    'SELECT COALESCE(SUM(fuel_cost), 0) as total FROM trip_route_legs WHERE trip_id = ? AND is_road_trip = 1 AND fuel_cost IS NOT NULL'
  ).get(tripId) as { total: number };
  const totalFuel = Math.round(row.total * 100) / 100;

  // Find existing auto-fuel budget entry
  const existing = db.prepare(
    'SELECT id FROM budget_items WHERE trip_id = ? AND note LIKE ?'
  ).get(tripId, `%${AUTO_FUEL_MARKER}%`) as { id: number } | undefined;

  if (totalFuel > 0) {
    const tripRow = db.prepare('SELECT roadtrip_fuel_currency FROM trips WHERE id = ?').get(tripId) as { roadtrip_fuel_currency: string | null } | undefined;
    const currency = tripRow?.roadtrip_fuel_currency || getUserSetting(userId, 'roadtrip_fuel_currency') || 'USD';
    const name = `Road Trip Fuel (${currency})`;
    if (existing) {
      db.prepare("UPDATE budget_items SET total_price = ?, name = ? WHERE id = ?").run(totalFuel, name, existing.id);
    } else {
      const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM budget_items WHERE trip_id = ?').get(tripId) as { max: number | null };
      const sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;
      db.prepare(
        'INSERT INTO budget_items (trip_id, category, name, total_price, note, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(tripId, 'Transport', name, totalFuel, AUTO_FUEL_MARKER, sortOrder);
    }
  } else if (existing) {
    db.prepare('DELETE FROM budget_items WHERE id = ?').run(existing.id);
  }
}

// GET /api/trips/:tripId/route-legs — list all route legs for a trip
router.get('/', authenticate, requireAddon, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const legs = db.prepare(`
    SELECT rl.*,
      pf.name as from_place_name, pf.lat as from_lat, pf.lng as from_lng,
      pt.name as to_place_name, pt.lat as to_lat, pt.lng as to_lng
    FROM trip_route_legs rl
    LEFT JOIN places pf ON rl.from_place_id = pf.id
    LEFT JOIN places pt ON rl.to_place_id = pt.id
    WHERE rl.trip_id = ?
    ORDER BY rl.day_index, rl.id
  `).all(tripId);

  res.json({ legs });
});

// PUT /api/trips/:tripId/route-legs/:legId — update a route leg
router.put('/:legId', authenticate, requireAddon, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, legId } = req.params;
  const { is_road_trip, route_profile } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const leg = db.prepare('SELECT id FROM trip_route_legs WHERE id = ? AND trip_id = ?').get(legId, tripId);
  if (!leg) return res.status(404).json({ error: 'Route leg not found' });

  const updates: string[] = [];
  const params: unknown[] = [];

  if (is_road_trip !== undefined) {
    updates.push('is_road_trip = ?');
    params.push(is_road_trip ? 1 : 0);
  }
  if (route_profile !== undefined) {
    updates.push('route_profile = ?');
    params.push(route_profile);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  params.push(legId, tripId);

  db.prepare(`UPDATE trip_route_legs SET ${updates.join(', ')} WHERE id = ? AND trip_id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM trip_route_legs WHERE id = ?').get(legId);
  res.json({ leg: updated });
});

// POST /api/trips/:tripId/route-legs/calculate — calculate route via OSRM
router.post('/calculate', authenticate, requireAddon, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { day_index, from_place_id, to_place_id } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (day_index === undefined || !from_place_id || !to_place_id) {
    return res.status(400).json({ error: 'day_index, from_place_id, and to_place_id are required' });
  }

  // Verify both places belong to this trip and have coordinates
  const fromPlace = db.prepare('SELECT id, name, lat, lng FROM places WHERE id = ? AND trip_id = ?').get(from_place_id, tripId) as { id: number; name: string; lat: number | null; lng: number | null } | undefined;
  const toPlace = db.prepare('SELECT id, name, lat, lng FROM places WHERE id = ? AND trip_id = ?').get(to_place_id, tripId) as { id: number; name: string; lat: number | null; lng: number | null } | undefined;

  if (!fromPlace || !toPlace) return res.status(404).json({ error: 'One or both places not found in this trip' });
  if (!fromPlace.lat || !fromPlace.lng || !toPlace.lat || !toPlace.lng) {
    return res.status(400).json({ error: 'Both places must have coordinates' });
  }

  // Rate limit: minimum 1 second between OSRM requests
  const now = Date.now();
  const elapsed = now - lastOsrmRequest;
  if (elapsed < 1000) {
    await new Promise(resolve => setTimeout(resolve, 1000 - elapsed));
  }
  lastOsrmRequest = Date.now();

  const url = `${OSRM_API_URL}/route/v1/driving/${fromPlace.lng},${fromPlace.lat};${toPlace.lng},${toPlace.lat}?overview=full&geometries=polyline&steps=true&annotations=speed,distance`;

  try {

    const response = await fetch(url, { agent: ipv4Agent });
    if (!response.ok) {
      console.error(`OSRM request failed: ${response.status} ${response.statusText} — URL: ${url}`);
      return res.status(502).json({ error: 'OSRM request failed' });
    }

    console.log(`OSRM route OK (${response.status}) — ${fromPlace.name} → ${toPlace.name}`);
    const data = await response.json();
    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      return res.status(422).json({ error: 'No route found between these places' });
    }

    const route = data.routes[0];
    const geometry = route.geometry; // encoded polyline string
    const distance_meters = route.distance;
    const osrm_duration_seconds = route.duration;

    // Extract annotations from first leg
    const leg0 = route.legs?.[0];
    const annotationSpeed: number[] = leg0?.annotation?.speed || [];
    const annotationDistance: number[] = leg0?.annotation?.distance || [];

    // Speed-cap calculation
    const maxSpeedMs = getMaxSpeedMs(authReq.user.id);
    let duration_seconds = osrm_duration_seconds;
    let speedCapped = false;

    if (maxSpeedMs && annotationSpeed.length > 0 && annotationDistance.length > 0) {
      duration_seconds = calculateSpeedCappedDuration(
        { speed: annotationSpeed, distance: annotationDistance },
        maxSpeedMs
      );
      speedCapped = true;
    }

    // Extract directions from steps
    const steps = leg0?.steps || [];
    const directions = extractDirections(steps);

    // Build route_metadata JSON
    const route_metadata = JSON.stringify({
      annotations: { speed: annotationSpeed, distance: annotationDistance },
      osrm_duration_seconds,
      speed_capped: speedCapped,
      max_speed_ms: maxSpeedMs || null,
      directions,
      direction_count: directions.length,
    });

    // Calculate fuel cost from user settings (distance-based, unaffected by speed cap)
    const fuel_cost = calculateFuelCost(distance_meters, authReq.user.id, tripId);

    // Upsert the route leg
    db.prepare(`
      INSERT INTO trip_route_legs (trip_id, day_index, from_place_id, to_place_id, is_road_trip, route_geometry, distance_meters, duration_seconds, fuel_cost, route_metadata, route_profile, calculated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(trip_id, day_index, from_place_id, to_place_id) DO UPDATE SET
        route_geometry = excluded.route_geometry,
        distance_meters = excluded.distance_meters,
        duration_seconds = excluded.duration_seconds,
        fuel_cost = excluded.fuel_cost,
        route_metadata = excluded.route_metadata,
        route_profile = excluded.route_profile,
        calculated_at = excluded.calculated_at,
        is_road_trip = 1,
        updated_at = datetime('now')
    `).run(tripId, day_index, from_place_id, to_place_id, geometry, distance_meters, duration_seconds, fuel_cost, route_metadata, 'driving');

    const leg = db.prepare(`
      SELECT rl.*,
        pf.name as from_place_name, pf.lat as from_lat, pf.lng as from_lng,
        pt.name as to_place_name, pt.lat as to_lat, pt.lng as to_lng
      FROM trip_route_legs rl
      LEFT JOIN places pf ON rl.from_place_id = pf.id
      LEFT JOIN places pt ON rl.to_place_id = pt.id
      WHERE rl.trip_id = ? AND rl.day_index = ? AND rl.from_place_id = ? AND rl.to_place_id = ?
    `).get(tripId, day_index, from_place_id, to_place_id);

    syncFuelBudget(tripId, authReq.user.id);
    res.json({ leg });
  } catch (err: unknown) {
    console.error('OSRM calculation error:', err instanceof Error ? err.message : err);
    console.error('OSRM URL was:', url);
    res.status(502).json({ error: 'Failed to calculate route' });
  }
});

// POST /api/trips/:tripId/route-legs/recalculate — recalculate fuel costs and speed-capped durations
router.post('/recalculate', authenticate, requireAddon, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const legs = db.prepare('SELECT id, distance_meters, route_metadata FROM trip_route_legs WHERE trip_id = ? AND distance_meters IS NOT NULL').all(tripId) as { id: number; distance_meters: number; route_metadata: string | null }[];

  const maxSpeedMs = getMaxSpeedMs(authReq.user.id);
  const updateFuelOnly = db.prepare("UPDATE trip_route_legs SET fuel_cost = ?, updated_at = datetime('now') WHERE id = ?");
  const updateFuelAndDuration = db.prepare("UPDATE trip_route_legs SET fuel_cost = ?, duration_seconds = ?, route_metadata = ?, updated_at = datetime('now') WHERE id = ?");

  const transaction = db.transaction(() => {
    for (const leg of legs) {
      const cost = calculateFuelCost(leg.distance_meters, authReq.user.id, tripId);

      // Recalculate speed-capped duration if annotations exist
      if (leg.route_metadata) {
        try {
          const meta = JSON.parse(leg.route_metadata);
          const annotations = meta.annotations;
          if (annotations?.speed?.length > 0 && annotations?.distance?.length > 0) {
            let newDuration: number;
            let speedCapped = false;
            if (maxSpeedMs) {
              newDuration = calculateSpeedCappedDuration(annotations, maxSpeedMs);
              speedCapped = true;
            } else {
              // No cap — restore original OSRM duration
              newDuration = meta.osrm_duration_seconds;
            }
            const updatedMeta = JSON.stringify({
              ...meta,
              speed_capped: speedCapped,
              max_speed_ms: maxSpeedMs || null,
            });
            updateFuelAndDuration.run(cost, newDuration, updatedMeta, leg.id);
            continue;
          }
        } catch {
          // Invalid JSON, fall through to fuel-only update
        }
      }
      updateFuelOnly.run(cost, leg.id);
    }
  });
  transaction();

  const updated = db.prepare(`
    SELECT rl.*,
      pf.name as from_place_name, pf.lat as from_lat, pf.lng as from_lng,
      pt.name as to_place_name, pt.lat as to_lat, pt.lng as to_lng
    FROM trip_route_legs rl
    LEFT JOIN places pf ON rl.from_place_id = pf.id
    LEFT JOIN places pt ON rl.to_place_id = pt.id
    WHERE rl.trip_id = ?
    ORDER BY rl.day_index, rl.id
  `).all(tripId);

  syncFuelBudget(tripId, authReq.user.id);
  res.json({ legs: updated });
});

// Haversine distance in meters
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Decode Google-encoded polyline into [lat, lng] pairs */
function decodePolyline(encoded: string): [number, number][] {
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

/** Perpendicular distance from a point to a line segment A→B, in meters */
function distanceToSegment(pLat: number, pLng: number, aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dAB = haversineDistance(aLat, aLng, bLat, bLng);
  if (dAB < 1) return haversineDistance(pLat, pLng, aLat, aLng); // degenerate segment

  const dAP = haversineDistance(aLat, aLng, pLat, pLng);
  const dBP = haversineDistance(bLat, bLng, pLat, pLng);

  // Use the formula: project P onto line AB, clamp to segment
  // Along-track fraction (dot product approximation using flat-earth for short segments)
  const toRad = Math.PI / 180;
  const cosLat = Math.cos(aLat * toRad);
  const dx = (bLng - aLng) * toRad * cosLat;
  const dy = (bLat - aLat) * toRad;
  const px = (pLng - aLng) * toRad * cosLat;
  const py = (pLat - aLat) * toRad;

  const dot = px * dx + py * dy;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, dot / lenSq)) : 0;

  // Interpolated closest point on segment
  const closestLat = aLat + t * (bLat - aLat);
  const closestLng = aLng + t * (bLng - aLng);
  return haversineDistance(pLat, pLng, closestLat, closestLng);
}

/** Minimum distance from a point to any segment of a polyline, in meters */
function distanceToPolyline(pointLat: number, pointLng: number, polylineCoords: [number, number][]): number {
  let minDist = Infinity;
  for (let i = 0; i < polylineCoords.length - 1; i++) {
    const d = distanceToSegment(
      pointLat, pointLng,
      polylineCoords[i][0], polylineCoords[i][1],
      polylineCoords[i + 1][0], polylineCoords[i + 1][1]
    );
    if (d < minDist) minDist = d;
    if (d < 10) break; // close enough, no need to check more
  }
  return minDist;
}

interface SearchPoint { lat: number; lng: number; distance_along_route_meters: number }
interface StopResult {
  name: string; lat: number; lng: number; type: 'fuel' | 'rest';
  distance_from_route_meters: number; source: 'osm' | 'google';
  brand: string | null; rating: number | null; opening_hours: string | null;
  osm_id: string | null; place_id: string | null;
}

// Debounce: track last find-stops call per leg to avoid rapid re-calls
const lastFindStopsCall = new Map<string, number>();

const SEARCH_RADII = [15000, 50000, 100000, 200000];

// Brand tag mappings for Overpass
const BRAND_OVERPASS_TAGS: Record<string, string[]> = {
  'Mobil': ['Mobil', 'Mobil 1'],
  'Ampol': ['Ampol'],
  'BP': ['BP'],
  'Shell': ['Shell', 'Shell Coles Express'],
  '7-Eleven': ['7-Eleven', '7-11'],
};

function buildFuelFilters(around: string, fuelType: string, fuelBrand: string): string[] {
  const filters: string[] = [];

  // Brand-specific queries first (if brand preference set)
  const brands = fuelBrand === 'any' ? [] : fuelBrand.split(',').map(b => b.trim()).filter(Boolean);
  for (const brand of brands) {
    const tags = BRAND_OVERPASS_TAGS[brand];
    if (!tags) continue;
    for (const tag of tags) {
      filters.push(`node["brand"="${tag}"]["amenity"="fuel"](${around});`);
      filters.push(`node["operator"="${tag}"]["amenity"="fuel"](${around});`);
    }
  }

  // Fuel type specific queries
  if (fuelType === 'diesel') {
    filters.push(`node["fuel:diesel"="yes"](${around});`);
  } else if (fuelType === 'petrol') {
    filters.push(`node["fuel:octane_91"="yes"](${around});`);
    filters.push(`node["fuel:octane_95"="yes"](${around});`);
  } else {
    // 'any' — broad search
    filters.push(`node["amenity"="fuel"](${around});`);
    filters.push(`node["fuel:diesel"="yes"](${around});`);
  }
  filters.push(`node["shop"="fuel"](${around});`);
  return filters;
}

async function runOverpassQuery(points: SearchPoint[], stopType: string, radiusMeters: number, fuelType: string = 'any', fuelBrand: string = 'any'): Promise<any[]> {
  const filters: string[] = [];
  for (const sp of points) {
    const around = `around:${radiusMeters},${sp.lat},${sp.lng}`;
    if (stopType === 'fuel' || stopType === 'both') {
      filters.push(...buildFuelFilters(around, fuelType, fuelBrand));
    }
    if (stopType === 'rest' || stopType === 'both') filters.push(`node["highway"="rest_area"](${around});`);
  }
  const query = `[out:json][timeout:30];(${filters.join('')});out body;`;
  console.log(`[find-stops] Overpass query: ${points.length} points, radius:${radiusMeters}m, type:${stopType}, query length:${query.length}`);

  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'TREK-TravelPlanner/1.0' },
      body: `data=${encodeURIComponent(query)}`,
      agent: ipv4Agent,
    });
    const body = await res.text();
    console.log(`[find-stops] Overpass response status: ${res.status}, body length: ${body.length}`);
    if (!res.ok) {
      console.error(`[find-stops] Overpass error response: ${body.substring(0, 500)}`);
      return [];
    }
    const data = JSON.parse(body) as { elements?: any[] };
    console.log(`[find-stops] Overpass POIs returned: ${(data.elements || []).length}`);
    return data.elements || [];
  } catch (err) {
    console.error('[find-stops] Overpass fetch error:', err);
    return [];
  }
}

function deduplicateElements(elements: any[]): any[] {
  const seen = new Set<number>();
  return elements.filter(el => {
    if (seen.has(el.id)) return false;
    seen.add(el.id);
    return true;
  });
}

function isFuelElement(el: any): boolean {
  return el.tags?.amenity === 'fuel' || el.tags?.shop === 'fuel' || el.tags?.['fuel:diesel'] === 'yes';
}

function elementsToStopResults(elements: any[]): StopResult[] {
  return elements.map(el => ({
    name: el.tags?.name || el.tags?.brand || 'Unknown',
    lat: el.lat, lng: el.lon,
    type: (isFuelElement(el) ? 'fuel' : 'rest') as 'fuel' | 'rest',
    distance_from_route_meters: 0,
    source: 'osm' as const,
    brand: el.tags?.brand || null,
    rating: null,
    opening_hours: el.tags?.opening_hours || null,
    osm_id: `node/${el.id}`,
    place_id: null,
  }));
}

function assignBestPoi(sp: SearchPoint, allPois: StopResult[], radiusMeters: number): StopResult[] {
  const scored = allPois.map(poi => ({
    ...poi,
    distance_from_route_meters: Math.round(haversineDistance(sp.lat, sp.lng, poi.lat, poi.lng)),
  }));
  scored.sort((a, b) => a.distance_from_route_meters - b.distance_from_route_meters);
  const best = scored.filter(p => p.distance_from_route_meters <= radiusMeters).slice(0, 1);
  if (best.length > 0) {
    console.log(`[find-stops] Found ${best[0].name} at ${best[0].distance_from_route_meters}m from route (search radius: ${radiusMeters}m)`);
  }
  return best;
}

async function searchOverpassBatched(searchPoints: SearchPoint[], stopType: string, fuelType: string = 'any', fuelBrand: string = 'any'): Promise<Map<number, StopResult[]>> {
  const resultsByPoint = new Map<number, StopResult[]>();
  // Track which point indices still need results
  let pendingIndices = searchPoints.map((_, i) => i);
  // Accumulate all unique elements across tiers for scoring
  let allElements: any[] = [];

  for (const radius of SEARCH_RADII) {
    if (pendingIndices.length === 0) break;

    const pendingPoints = pendingIndices.map(i => searchPoints[i]);
    const elements = await runOverpassQuery(pendingPoints, stopType, radius, fuelType, fuelBrand);
    allElements = deduplicateElements([...allElements, ...elements]);
    const allPois = elementsToStopResults(allElements);

    const stillPending: number[] = [];
    for (const idx of pendingIndices) {
      const best = assignBestPoi(searchPoints[idx], allPois, radius);
      if (best.length > 0) {
        resultsByPoint.set(idx, best);
      } else {
        stillPending.push(idx);
      }
    }

    if (stillPending.length > 0 && radius < SEARCH_RADII[SEARCH_RADII.length - 1]) {
      const nextRadius = SEARCH_RADII[SEARCH_RADII.indexOf(radius) + 1];
      console.log(`[find-stops] Overpass: ${stillPending.length} points had no results at ${radius}m, retrying at ${nextRadius}m`);
    }
    pendingIndices = stillPending;
  }

  // Set empty results for any points that never got results
  for (const idx of pendingIndices) {
    resultsByPoint.set(idx, []);
  }

  return resultsByPoint;
}

/** Corridor search: find ALL fuel/rest within the route corridor, return all deduplicated */
async function searchCorridorOverpass(searchPoints: SearchPoint[], stopType: string, fuelType: string = 'any', fuelBrand: string = 'any'): Promise<StopResult[]> {
  let allElements: any[] = [];

  for (const radius of SEARCH_RADII) {
    const elements = await runOverpassQuery(searchPoints, stopType, radius, fuelType, fuelBrand);
    allElements = deduplicateElements([...allElements, ...elements]);
    // For corridor mode, check if we have reasonable coverage — if every point has at least one result within this radius, stop expanding
    const allPois = elementsToStopResults(allElements);
    const uncoveredCount = searchPoints.filter(sp =>
      !allPois.some(poi => haversineDistance(sp.lat, sp.lng, poi.lat, poi.lng) <= radius)
    ).length;
    if (uncoveredCount === 0) {
      console.log(`[find-stops] Corridor Overpass: full coverage at ${radius}m radius, ${allElements.length} total POIs`);
      break;
    }
    if (radius < SEARCH_RADII[SEARCH_RADII.length - 1]) {
      console.log(`[find-stops] Corridor Overpass: ${uncoveredCount} uncovered points at ${radius}m, expanding`);
    }
  }

  console.log(`[find-stops] Corridor Overpass: ${allElements.length} unique POIs found`);
  const results = elementsToStopResults(allElements);
  // Calculate distance_from_route as min distance to any search point
  return results.map(poi => {
    let minDist = Infinity;
    for (const sp of searchPoints) {
      const d = haversineDistance(sp.lat, sp.lng, poi.lat, poi.lng);
      if (d < minDist) minDist = d;
    }
    return { ...poi, distance_from_route_meters: Math.round(minDist) };
  });
}

/** Corridor search via Google Places: search at all points, deduplicate results */
async function searchCorridorGoogle(searchPoints: SearchPoint[], stopType: string, apiKey: string, fuelType: string = 'any', fuelBrand: string = 'any'): Promise<StopResult[]> {
  const allResults: StopResult[] = [];
  const seenIds = new Set<string>();

  for (const sp of searchPoints) {
    const results = await searchGooglePlaces(sp.lat, sp.lng, stopType, apiKey);
    for (const r of results) {
      const key = r.place_id || `${r.lat},${r.lng}`;
      if (!seenIds.has(key)) {
        seenIds.add(key);
        allResults.push(r);
      }
    }
  }

  // Fall back to Overpass for any points with no nearby results
  const uncoveredPoints = searchPoints.filter(sp =>
    !allResults.some(r => haversineDistance(sp.lat, sp.lng, r.lat, r.lng) <= 50000)
  );
  if (uncoveredPoints.length > 0) {
    console.log(`[find-stops] Corridor Google: ${uncoveredPoints.length} points had no nearby results, falling back to Overpass`);
    const overpassResults = await searchCorridorOverpass(uncoveredPoints, stopType, fuelType, fuelBrand);
    const overpassDeduped = overpassResults.filter(r => {
      const key = r.osm_id || `${r.lat},${r.lng}`;
      if (seenIds.has(key)) return false;
      seenIds.add(key);
      return true;
    });
    allResults.push(...overpassDeduped);
  }

  return allResults;
}

function getGlobalMapsKey(): string | null {
  const admin = db.prepare("SELECT maps_api_key FROM users WHERE role = 'admin' AND maps_api_key IS NOT NULL AND maps_api_key != '' LIMIT 1").get() as { maps_api_key: string } | undefined;
  return admin?.maps_api_key || null;
}

async function searchGooglePlacesAtRadius(lat: number, lng: number, searchType: string, apiKey: string, radiusMeters: number): Promise<StopResult[]> {
  const results: StopResult[] = [];
  const includedTypes = searchType === 'fuel' ? ['gas_station'] : ['rest_stop'];
  console.log(`[find-stops] Google Places search types:${includedTypes.join(',')} near ${lat},${lng} radius:${radiusMeters}m`);
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.rating,places.regularOpeningHours',
      },
      body: JSON.stringify({
        includedTypes,
        maxResultCount: 5,
        locationRestriction: {
          circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(radiusMeters, 50000.0) },
        },
      }),
      agent: ipv4Agent,
    });
    const body = await res.text();
    console.log(`[find-stops] Google Places response status: ${res.status}, body length: ${body.length}`);
    if (!res.ok) {
      console.error(`[find-stops] Google Places error: ${body.substring(0, 500)}`);
      return [];
    }
    const data = JSON.parse(body) as { places?: any[] };
    for (const r of data.places || []) {
      const dist = Math.round(haversineDistance(lat, lng, r.location?.latitude || 0, r.location?.longitude || 0));
      const name = r.displayName?.text || 'Unknown';
      console.log(`[find-stops] Found ${name} at ${dist}m from route (search radius: ${radiusMeters}m)`);
      results.push({
        name,
        lat: r.location?.latitude, lng: r.location?.longitude,
        type: searchType as 'fuel' | 'rest',
        distance_from_route_meters: dist,
        source: 'google',
        brand: null,
        rating: r.rating || null,
        opening_hours: r.regularOpeningHours?.openNow != null ? (r.regularOpeningHours.openNow ? 'Open now' : 'Closed') : null,
        osm_id: null,
        place_id: r.id || null,
      });
    }
  } catch (err) {
    console.error('[find-stops] Google Places fetch error:', err);
  }
  return results;
}

async function searchGooglePlaces(lat: number, lng: number, stopType: string, apiKey: string): Promise<StopResult[]> {
  const searchTypes: string[] = [];
  if (stopType === 'fuel' || stopType === 'both') searchTypes.push('fuel');
  if (stopType === 'rest' || stopType === 'both') searchTypes.push('rest');

  const allResults: StopResult[] = [];
  // Google Places API maxes at 50km radius, so for larger radii we use offset grid points
  const GOOGLE_RADII = [15000, 50000];

  for (const sType of searchTypes) {
    let found = false;
    for (const radius of GOOGLE_RADII) {
      const results = await searchGooglePlacesAtRadius(lat, lng, sType, apiKey, radius);
      if (results.length > 0) {
        allResults.push(...results);
        found = true;
        break;
      }
      if (radius < GOOGLE_RADII[GOOGLE_RADII.length - 1]) {
        const nextRadius = GOOGLE_RADII[GOOGLE_RADII.indexOf(radius) + 1];
        console.log(`[find-stops] Google Places: no results at ${radius}m, expanding to ${nextRadius}m for point ${lat},${lng}`);
      }
    }
    if (!found) {
      console.log(`[find-stops] Google Places: no ${sType} results at any radius for point ${lat},${lng}`);
    }
  }
  return allResults;
}

// POST /api/trips/:tripId/route-legs/:legId/find-stops — find real fuel/rest stops near route
router.post('/:legId/find-stops', authenticate, requireAddon, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, legId } = req.params;
  const { stop_type, search_points, corridor } = req.body as { stop_type: string; search_points: SearchPoint[]; corridor?: boolean };

  console.log(`[find-stops] called for leg ${legId}, type: ${stop_type}, points: ${search_points?.length || 0}, corridor: ${!!corridor}`);

  // Debounce: reject if called within 5 seconds for the same leg+type
  const debounceKey = `${tripId}-${legId}-${stop_type}`;
  const lastCall = lastFindStopsCall.get(debounceKey) || 0;
  if (Date.now() - lastCall < 5000) {
    return res.status(429).json({ error: 'Please wait a few seconds before searching again' });
  }
  lastFindStopsCall.set(debounceKey, Date.now());

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const leg = db.prepare('SELECT id, route_metadata, route_geometry FROM trip_route_legs WHERE id = ? AND trip_id = ?').get(legId, tripId) as { id: number; route_metadata: string | null; route_geometry: string | null } | undefined;
  if (!leg) return res.status(404).json({ error: 'Route leg not found' });

  // Decode route polyline for distance-from-route filtering
  const routePolyline: [number, number][] | null = leg.route_geometry ? decodePolyline(leg.route_geometry) : null;

  if (!search_points || search_points.length === 0) {
    return res.status(400).json({ error: 'search_points are required' });
  }

  const source = getUserSetting(authReq.user.id, 'roadtrip_stop_source') || 'osm';
  const apiKey = getGlobalMapsKey();
  const fuelType = getUserSetting(authReq.user.id, 'roadtrip_fuel_type') || 'any';
  const fuelBrand = getUserSetting(authReq.user.id, 'roadtrip_fuel_brand') || 'any';

  const useGoogle = source === 'google' && apiKey;
  console.log(`[find-stops] source: ${source}, useGoogle: ${!!useGoogle}, fuelType: ${fuelType}, fuelBrand: ${fuelBrand}`);
  const validType = ['fuel', 'rest', 'both'].includes(stop_type) ? stop_type : 'both';
  const cappedPoints = search_points.slice(0, 20); // allow more points for corridor mode

  let allFoundStops: (StopResult & { distance_along_route_meters: number })[] = [];

  if (corridor) {
    // Corridor mode: find ALL stops along the route corridor
    console.log(`[find-stops] Corridor mode: searching entire route corridor`);
    let corridorResults: StopResult[];
    if (useGoogle) {
      corridorResults = await searchCorridorGoogle(cappedPoints, validType, apiKey!, fuelType, fuelBrand);
    } else {
      corridorResults = await searchCorridorOverpass(cappedPoints, validType, fuelType, fuelBrand);
    }
    // Calculate distance_along_route for each result: find closest corridor sample point
    // and use that point's distance_along_route_meters as approximation
    allFoundStops = corridorResults.map(r => {
      let closestDist = Infinity;
      let closestPointDist = 0;
      for (const sp of cappedPoints) {
        const d = haversineDistance(r.lat, r.lng, sp.lat, sp.lng);
        if (d < closestDist) {
          closestDist = d;
          closestPointDist = sp.distance_along_route_meters;
        }
      }
      return { ...r, distance_along_route_meters: closestPointDist };
    });
    // Sort by distance along route
    allFoundStops.sort((a, b) => a.distance_along_route_meters - b.distance_along_route_meters);
    console.log(`[find-stops] Corridor: ${allFoundStops.length} total stops found along corridor`);
  } else {
    // Point mode: find best stop near each search point (rest stops, etc.)
    const stops: { search_point: SearchPoint; results: StopResult[] }[] = [];

    if (useGoogle) {
      for (const sp of cappedPoints) {
        const results = await searchGooglePlaces(sp.lat, sp.lng, validType, apiKey!);
        results.sort((a, b) => a.distance_from_route_meters - b.distance_from_route_meters);
        stops.push({ search_point: sp, results: results.slice(0, 1) });
      }
      const emptyIndices = stops.map((s, i) => s.results.length === 0 ? i : -1).filter(i => i >= 0);
      if (emptyIndices.length > 0) {
        console.log(`[find-stops] Google Places: ${emptyIndices.length} points had no results, falling back to Overpass`);
        const fallbackPoints = emptyIndices.map(i => cappedPoints[i]);
        const overpassResults = await searchOverpassBatched(fallbackPoints, validType, fuelType, fuelBrand);
        for (let j = 0; j < emptyIndices.length; j++) {
          const results = overpassResults.get(j) || [];
          if (results.length > 0) {
            stops[emptyIndices[j]] = { search_point: cappedPoints[emptyIndices[j]], results };
          }
        }
      }
    } else {
      const resultsByPoint = await searchOverpassBatched(cappedPoints, validType, fuelType, fuelBrand);
      for (let i = 0; i < cappedPoints.length; i++) {
        stops.push({ search_point: cappedPoints[i], results: resultsByPoint.get(i) || [] });
      }
    }

    allFoundStops = stops.flatMap(s =>
      s.results.map(r => ({
        ...r,
        distance_along_route_meters: s.search_point.distance_along_route_meters,
      }))
    );
  }

  // Cross-type dedup: if a rest stop is within 5km of a fuel stop, drop the rest stop
  const fuelStops = allFoundStops.filter(s => s.type === 'fuel');
  if (fuelStops.length > 0) {
    allFoundStops = allFoundStops.filter(s => {
      if (s.type !== 'rest') return true;
      return !fuelStops.some(f => haversineDistance(s.lat, s.lng, f.lat, f.lng) < 5000);
    });
  }
  // Dedup by location (within 500m = same station)
  const dedupedStops: typeof allFoundStops = [];
  for (const stop of allFoundStops) {
    const isDupe = dedupedStops.some(s =>
      s.type === stop.type && haversineDistance(s.lat, s.lng, stop.lat, stop.lng) < 500
    );
    if (!isDupe) dedupedStops.push(stop);
  }
  allFoundStops = dedupedStops;

  // Filter by true distance from route polyline (max 2km)
  if (routePolyline && routePolyline.length >= 2) {
    const beforeCount = allFoundStops.length;
    allFoundStops = allFoundStops.filter(stop => {
      const dist = distanceToPolyline(stop.lat, stop.lng, routePolyline);
      stop.distance_from_route_meters = Math.round(dist);
      return dist <= 2000;
    });
    console.log(`[find-stops] Filtered ${beforeCount} POIs to ${allFoundStops.length} within 2km of route`);
  }

  // Sort: preferred brands first if set
  if (fuelBrand !== 'any') {
    const brands = fuelBrand.split(',').map(b => b.trim().toLowerCase()).filter(Boolean);
    const matchesBrand = (stop: any) =>
      brands.some(b => stop.brand?.toLowerCase().includes(b) || stop.name?.toLowerCase().includes(b));
    allFoundStops.sort((a, b) => {
      const aMatch = matchesBrand(a) ? 0 : 1;
      const bMatch = matchesBrand(b) ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      return a.distance_along_route_meters - b.distance_along_route_meters;
    });
  }

  console.log(`[find-stops] total results: ${allFoundStops.length}`);

  try {
    const meta = leg.route_metadata ? JSON.parse(leg.route_metadata) : {};
    const existing: any[] = Array.isArray(meta.found_stops) ? meta.found_stops : [];
    if (validType === 'both') {
      // Full replacement
      meta.found_stops = allFoundStops;
    } else {
      // Merge: keep existing stops of other types, replace stops of this type
      const otherStops = existing.filter((s: any) => s.type !== validType);
      meta.found_stops = [...otherStops, ...allFoundStops];
    }
    db.prepare("UPDATE trip_route_legs SET route_metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(meta), legId);
  } catch (err) {
    console.error('[find-stops] Error storing route_metadata:', err);
  }

  res.json({ stops: allFoundStops });
});

// DELETE /api/trips/:tripId/route-legs/:legId — remove a route leg
router.delete('/:legId', authenticate, requireAddon, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, legId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const leg = db.prepare('SELECT id FROM trip_route_legs WHERE id = ? AND trip_id = ?').get(legId, tripId);
  if (!leg) return res.status(404).json({ error: 'Route leg not found' });

  db.prepare('DELETE FROM trip_route_legs WHERE id = ?').run(legId);
  syncFuelBudget(tripId, authReq.user.id);
  res.json({ success: true });
});

export default router;
