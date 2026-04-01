import express, { Request, Response } from 'express';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import {
  fetchOsrmRoute, extractDirections, calculateSpeedCappedDuration,
  isValidLatitude, isValidLongitude,
} from '../services/routingService';
import {
  isRoadtripEnabled, getUserSetting, getMaxSpeedMs,
  calculateFuelCost, syncFuelBudget, recalculateLegs,
} from '../services/fuelService';
import {
  findStopsForLeg, deduplicateAndFilterStops, checkDebounce,
  isValidStopType,
  type SearchPoint,
} from '../services/stopSearchService';

const router = express.Router({ mergeParams: true });

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

function parseIntParam(value: string): number | null {
  const n = parseInt(value, 10);
  return isNaN(n) ? null : n;
}

function validateTripId(tripId: string | undefined): boolean {
  return typeof tripId === 'string' && tripId.length > 0;
}

// GET /api/trips/:tripId/route-legs
router.get('/', authenticate, requireAddon, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!validateTripId(tripId)) return res.status(400).json({ error: 'Invalid trip ID' });

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

// PUT /api/trips/:tripId/route-legs/:legId
router.put('/:legId', authenticate, requireAddon, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!validateTripId(tripId)) return res.status(400).json({ error: 'Invalid trip ID' });

  const legId = parseIntParam(req.params.legId);
  if (legId === null) return res.status(400).json({ error: 'Invalid leg ID' });

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

// POST /api/trips/:tripId/route-legs/calculate
router.post('/calculate', authenticate, requireAddon, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!validateTripId(tripId)) return res.status(400).json({ error: 'Invalid trip ID' });

  const { day_index, from_place_id, to_place_id } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (day_index === undefined || !from_place_id || !to_place_id) {
    return res.status(400).json({ error: 'day_index, from_place_id, and to_place_id are required' });
  }

  const fromPlace = db.prepare('SELECT id, name, lat, lng FROM places WHERE id = ? AND trip_id = ?').get(from_place_id, tripId) as { id: number; name: string; lat: number | null; lng: number | null } | undefined;
  const toPlace = db.prepare('SELECT id, name, lat, lng FROM places WHERE id = ? AND trip_id = ?').get(to_place_id, tripId) as { id: number; name: string; lat: number | null; lng: number | null } | undefined;

  if (!fromPlace || !toPlace) return res.status(404).json({ error: 'One or both places not found in this trip' });
  if (!fromPlace.lat || !fromPlace.lng || !toPlace.lat || !toPlace.lng) {
    return res.status(400).json({ error: 'Both places must have coordinates' });
  }

  if (!isValidLatitude(fromPlace.lat) || !isValidLongitude(fromPlace.lng) ||
      !isValidLatitude(toPlace.lat) || !isValidLongitude(toPlace.lng)) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  try {
    const data = await fetchOsrmRoute(fromPlace.lng, fromPlace.lat, toPlace.lng, toPlace.lat);

    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      return res.status(422).json({ error: 'No route found between these places' });
    }

    const route = data.routes[0];
    const geometry = route.geometry;
    const distance_meters = route.distance;
    const osrm_duration_seconds = route.duration;

    const leg0 = route.legs?.[0];
    const annotationSpeed: number[] = leg0?.annotation?.speed || [];
    const annotationDistance: number[] = leg0?.annotation?.distance || [];

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

    const steps = leg0?.steps || [];
    const directions = extractDirections(steps);

    const route_metadata = JSON.stringify({
      annotations: { speed: annotationSpeed, distance: annotationDistance },
      osrm_duration_seconds,
      speed_capped: speedCapped,
      max_speed_ms: maxSpeedMs || null,
      directions,
      direction_count: directions.length,
    });

    const fuel_cost = calculateFuelCost(distance_meters, authReq.user.id, tripId);

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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('timed out')) {
      return res.status(504).json({ error: 'OSRM request timed out' });
    }
    console.error('OSRM calculation error:', message);
    res.status(502).json({ error: 'Failed to calculate route' });
  }
});

// POST /api/trips/:tripId/route-legs/recalculate
router.post('/recalculate', authenticate, requireAddon, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!validateTripId(tripId)) return res.status(400).json({ error: 'Invalid trip ID' });

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  recalculateLegs(tripId, authReq.user.id);

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

// POST /api/trips/:tripId/route-legs/:legId/find-stops
router.post('/:legId/find-stops', authenticate, requireAddon, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!validateTripId(tripId)) return res.status(400).json({ error: 'Invalid trip ID' });

  const legId = parseIntParam(req.params.legId);
  if (legId === null) return res.status(400).json({ error: 'Invalid leg ID' });

  const { stop_type, search_points, corridor } = req.body as { stop_type: string; search_points: SearchPoint[]; corridor?: boolean };

  if (!stop_type || !isValidStopType(stop_type)) {
    return res.status(400).json({ error: "stop_type must be one of 'fuel', 'rest', 'both'" });
  }

  if (!search_points || !Array.isArray(search_points) || search_points.length === 0) {
    return res.status(400).json({ error: 'search_points are required' });
  }

  for (const sp of search_points) {
    if (!isValidLatitude(sp.lat) || !isValidLongitude(sp.lng)) {
      return res.status(400).json({ error: 'Invalid coordinates in search_points' });
    }
    if (typeof sp.distance_along_route_meters !== 'number' || isNaN(sp.distance_along_route_meters)) {
      return res.status(400).json({ error: 'Each search point must have a valid distance_along_route_meters' });
    }
  }

  console.log(`[find-stops] called for leg ${legId}, type: ${stop_type}, points: ${search_points.length}, corridor: ${!!corridor}`);

  const debounceKey = `${tripId}-${legId}-${stop_type}`;
  if (!checkDebounce(debounceKey)) {
    return res.status(429).json({ error: 'Please wait a few seconds before searching again' });
  }

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const leg = db.prepare('SELECT id, route_metadata, route_geometry FROM trip_route_legs WHERE id = ? AND trip_id = ?').get(legId, tripId) as { id: number; route_metadata: string | null; route_geometry: string | null } | undefined;
  if (!leg) return res.status(404).json({ error: 'Route leg not found' });

  const fuelBrand = getUserSetting(authReq.user.id, 'roadtrip_fuel_brand') || 'any';

  let allFoundStops = await findStopsForLeg({
    tripId, legId, userId: authReq.user.id,
    stopType: stop_type, searchPoints: search_points, corridor,
  });

  allFoundStops = deduplicateAndFilterStops(allFoundStops, leg.route_geometry, fuelBrand);

  console.log(`[find-stops] total results: ${allFoundStops.length}`);

  const validType = isValidStopType(stop_type) ? stop_type : 'both';
  try {
    const meta = leg.route_metadata ? JSON.parse(leg.route_metadata) : {};
    const existing: { type: string }[] = Array.isArray(meta.found_stops) ? meta.found_stops : [];
    if (validType === 'both') {
      meta.found_stops = allFoundStops;
    } else {
      const otherStops = existing.filter(s => s.type !== validType);
      meta.found_stops = [...otherStops, ...allFoundStops];
    }
    db.prepare("UPDATE trip_route_legs SET route_metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(meta), legId);
  } catch (err) {
    console.error('[find-stops] Error storing route_metadata:', err);
  }

  res.json({ stops: allFoundStops });
});

// DELETE /api/trips/:tripId/route-legs/:legId
router.delete('/:legId', authenticate, requireAddon, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!validateTripId(tripId)) return res.status(400).json({ error: 'Invalid trip ID' });

  const legId = parseIntParam(req.params.legId);
  if (legId === null) return res.status(400).json({ error: 'Invalid leg ID' });

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const leg = db.prepare('SELECT id FROM trip_route_legs WHERE id = ? AND trip_id = ?').get(legId, tripId);
  if (!leg) return res.status(404).json({ error: 'Route leg not found' });

  db.prepare('DELETE FROM trip_route_legs WHERE id = ?').run(legId);
  syncFuelBudget(tripId, authReq.user.id);
  res.json({ success: true });
});

export default router;
