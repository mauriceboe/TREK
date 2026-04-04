import express, { Request, Response } from 'express';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { AuthRequest, TripLeg } from '../types';

const router = express.Router();

const LEG_COLORS = ['#0f766e', '#0369a1', '#c2410c', '#7c3aed', '#be123c', '#15803d'];

// ── Helpers ──────────────────────────────────────────────────────────────────

export function parseNullableNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDayNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeTripLeg(leg: Record<string, unknown> | undefined | null): TripLeg | null {
  if (!leg) return null;
  return {
    ...(leg as unknown as TripLeg),
    destination_lat: leg.destination_lat == null ? null : Number(leg.destination_lat),
    destination_lng: leg.destination_lng == null ? null : Number(leg.destination_lng),
    destination_viewport_south: leg.destination_viewport_south == null ? null : Number(leg.destination_viewport_south),
    destination_viewport_west: leg.destination_viewport_west == null ? null : Number(leg.destination_viewport_west),
    destination_viewport_north: leg.destination_viewport_north == null ? null : Number(leg.destination_viewport_north),
    destination_viewport_east: leg.destination_viewport_east == null ? null : Number(leg.destination_viewport_east),
    start_day_number: Number(leg.start_day_number),
    end_day_number: Number(leg.end_day_number),
  };
}

export function getTripDayCount(tripId: number | string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM days WHERE trip_id = ?').get(tripId) as { count: number } | undefined;
  return Number(row?.count || 0);
}

export function getTripLegs(tripId: number | string): TripLeg[] {
  const rows = db.prepare(`
    SELECT * FROM trip_legs
    WHERE trip_id = ?
    ORDER BY start_day_number ASC, end_day_number ASC, id ASC
  `).all(tripId) as Record<string, unknown>[];
  return rows.map(normalizeTripLeg).filter((l): l is TripLeg => l !== null);
}

export function getTripLeg(tripId: number | string, legId: number | string): TripLeg | null {
  const leg = db.prepare('SELECT * FROM trip_legs WHERE trip_id = ? AND id = ?').get(tripId, legId) as Record<string, unknown> | undefined;
  return normalizeTripLeg(leg ?? null);
}

function validateLegRange({ dayCount, startDayNumber, endDayNumber }: { dayCount: number; startDayNumber: number | null; endDayNumber: number | null }): string | null {
  if (!Number.isInteger(startDayNumber) || !Number.isInteger(endDayNumber)) {
    return 'Start and end day are required';
  }
  if (startDayNumber! < 1 || endDayNumber! < 1) {
    return 'Leg days must start at day 1';
  }
  if (endDayNumber! < startDayNumber!) {
    return 'End day must be on or after start day';
  }
  if (dayCount > 0 && (startDayNumber! > dayCount || endDayNumber! > dayCount)) {
    return `Leg range must stay within the trip day count (${dayCount})`;
  }
  return null;
}

function hasLegOverlap(tripId: number | string, startDayNumber: number, endDayNumber: number, excludeLegId: number | null = null): boolean {
  const overlap = excludeLegId == null
    ? db.prepare(`
        SELECT id FROM trip_legs
        WHERE trip_id = ? AND start_day_number <= ? AND end_day_number >= ?
        LIMIT 1
      `).get(tripId, endDayNumber, startDayNumber)
    : db.prepare(`
        SELECT id FROM trip_legs
        WHERE trip_id = ? AND id != ? AND start_day_number <= ? AND end_day_number >= ?
        LIMIT 1
      `).get(tripId, excludeLegId, endDayNumber, startDayNumber);
  return Boolean(overlap);
}

export function syncTripLegsToDayCount(tripId: number | string): TripLeg[] {
  const dayCount = getTripDayCount(tripId);
  const legs = getTripLegs(tripId);

  if (dayCount <= 0) {
    db.prepare('DELETE FROM trip_legs WHERE trip_id = ?').run(tripId);
    return [];
  }

  const updateLeg = db.prepare('UPDATE trip_legs SET start_day_number = ?, end_day_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const deleteLeg = db.prepare('DELETE FROM trip_legs WHERE id = ?');

  for (const leg of legs) {
    if (leg.start_day_number > dayCount) {
      deleteLeg.run(leg.id);
      continue;
    }
    const nextStart = Math.max(1, Math.min(dayCount, leg.start_day_number));
    const nextEnd = Math.max(nextStart, Math.min(dayCount, leg.end_day_number));
    if (nextStart !== leg.start_day_number || nextEnd !== leg.end_day_number) {
      updateLeg.run(nextStart, nextEnd, leg.id);
    }
  }

  return getTripLegs(tripId);
}

interface LegPayload {
  destination_name: string;
  destination_address: string | null;
  destination_lat: number | null | undefined;
  destination_lng: number | null | undefined;
  destination_viewport_south: number | null | undefined;
  destination_viewport_west: number | null | undefined;
  destination_viewport_north: number | null | undefined;
  destination_viewport_east: number | null | undefined;
  start_day_number: number | null;
  end_day_number: number | null;
  color: string;
}

function buildLegPayload(body: Record<string, unknown>, fallbackColor: string): LegPayload {
  return {
    destination_name: String(body.destination_name || '').trim(),
    destination_address: body.destination_address ? String(body.destination_address).trim() : null,
    destination_lat: parseNullableNumber(body.destination_lat),
    destination_lng: parseNullableNumber(body.destination_lng),
    destination_viewport_south: parseNullableNumber(body.destination_viewport_south),
    destination_viewport_west: parseNullableNumber(body.destination_viewport_west),
    destination_viewport_north: parseNullableNumber(body.destination_viewport_north),
    destination_viewport_east: parseNullableNumber(body.destination_viewport_east),
    start_day_number: parseDayNumber(body.start_day_number),
    end_day_number: parseDayNumber(body.end_day_number),
    color: body.color ? String(body.color) : fallbackColor,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/trips/:id/legs
router.get('/:id/legs', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.id, authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  res.json({ legs: getTripLegs(req.params.id) });
});

// POST /api/trips/:id/legs
router.post('/:id/legs', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.id, authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const dayCount = getTripDayCount(req.params.id);
  const fallbackColor = LEG_COLORS[getTripLegs(req.params.id).length % LEG_COLORS.length];
  const payload = buildLegPayload(req.body, fallbackColor);

  if (!payload.destination_name) {
    return res.status(400).json({ error: 'Destination is required' });
  }

  const rangeError = validateLegRange({
    dayCount,
    startDayNumber: payload.start_day_number,
    endDayNumber: payload.end_day_number,
  });
  if (rangeError) return res.status(400).json({ error: rangeError });

  if (hasLegOverlap(req.params.id, payload.start_day_number!, payload.end_day_number!)) {
    return res.status(400).json({ error: 'Trip leg range overlaps an existing leg' });
  }

  const result = db.prepare(`
    INSERT INTO trip_legs (
      trip_id, destination_name, destination_address, destination_lat, destination_lng,
      destination_viewport_south, destination_viewport_west, destination_viewport_north, destination_viewport_east,
      start_day_number, end_day_number, color
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id,
    payload.destination_name,
    payload.destination_address,
    payload.destination_lat ?? null,
    payload.destination_lng ?? null,
    payload.destination_viewport_south ?? null,
    payload.destination_viewport_west ?? null,
    payload.destination_viewport_north ?? null,
    payload.destination_viewport_east ?? null,
    payload.start_day_number,
    payload.end_day_number,
    payload.color
  );

  const leg = getTripLeg(req.params.id, result.lastInsertRowid as number);
  res.status(201).json({ leg });
  broadcast(req.params.id, 'tripLeg:created', { leg }, req.headers['x-socket-id'] as string);
});

// PUT /api/trips/:id/legs/:legId
router.put('/:id/legs/:legId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.id, authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const existingLeg = getTripLeg(req.params.id, req.params.legId);
  if (!existingLeg) return res.status(404).json({ error: 'Trip leg not found' });

  const payload = buildLegPayload(
    { ...(existingLeg as unknown as Record<string, unknown>), ...req.body },
    existingLeg.color || LEG_COLORS[0]
  );

  if (!payload.destination_name) {
    return res.status(400).json({ error: 'Destination is required' });
  }

  const rangeError = validateLegRange({
    dayCount: getTripDayCount(req.params.id),
    startDayNumber: payload.start_day_number,
    endDayNumber: payload.end_day_number,
  });
  if (rangeError) return res.status(400).json({ error: rangeError });

  if (hasLegOverlap(req.params.id, payload.start_day_number!, payload.end_day_number!, Number(req.params.legId))) {
    return res.status(400).json({ error: 'Trip leg range overlaps an existing leg' });
  }

  db.prepare(`
    UPDATE trip_legs
    SET destination_name = ?, destination_address = ?, destination_lat = ?, destination_lng = ?,
      destination_viewport_south = ?, destination_viewport_west = ?, destination_viewport_north = ?, destination_viewport_east = ?,
      start_day_number = ?, end_day_number = ?, color = ?, updated_at = CURRENT_TIMESTAMP
    WHERE trip_id = ? AND id = ?
  `).run(
    payload.destination_name,
    payload.destination_address,
    payload.destination_lat ?? null,
    payload.destination_lng ?? null,
    payload.destination_viewport_south ?? null,
    payload.destination_viewport_west ?? null,
    payload.destination_viewport_north ?? null,
    payload.destination_viewport_east ?? null,
    payload.start_day_number,
    payload.end_day_number,
    payload.color,
    req.params.id,
    req.params.legId
  );

  const leg = getTripLeg(req.params.id, req.params.legId);
  res.json({ leg });
  broadcast(req.params.id, 'tripLeg:updated', { leg }, req.headers['x-socket-id'] as string);
});

// DELETE /api/trips/:id/legs/:legId
router.delete('/:id/legs/:legId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.id, authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const leg = getTripLeg(req.params.id, req.params.legId);
  if (!leg) return res.status(404).json({ error: 'Trip leg not found' });

  db.prepare('DELETE FROM trip_legs WHERE trip_id = ? AND id = ?').run(req.params.id, req.params.legId);
  res.json({ success: true });
  broadcast(req.params.id, 'tripLeg:deleted', { legId: leg.id }, req.headers['x-socket-id'] as string);
});

export default router;
