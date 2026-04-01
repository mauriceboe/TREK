import { db } from '../db/database';
import { Addon } from '../types';
import { calculateSpeedCappedDuration } from './routingService';

const AUTO_FUEL_MARKER = '[auto-fuel]';
const SAFETY_MARGIN_MINUTES = 30;

export { SAFETY_MARGIN_MINUTES };

export function isRoadtripEnabled(): boolean {
  const addon = db.prepare('SELECT enabled FROM addons WHERE id = ?').get('roadtrip') as Pick<Addon, 'enabled'> | undefined;
  return !!addon?.enabled;
}

export function getUserSetting(userId: number, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, key) as { value: string } | undefined;
  return row?.value || null;
}

export function getMaxSpeedMs(userId: number): number | null {
  const maxSpeed = getUserSetting(userId, 'roadtrip_max_speed');
  if (!maxSpeed) return null;
  const speed = parseFloat(maxSpeed);
  if (!speed || speed <= 0) return null;
  const unitSystem = getUserSetting(userId, 'roadtrip_unit_system') || 'metric';
  return unitSystem === 'imperial' ? speed * 0.44704 : speed / 3.6;
}

export function calculateFuelCost(distanceMeters: number, userId: number, tripId?: string | number): number | null {
  const unitSystem = getUserSetting(userId, 'roadtrip_unit_system') || 'metric';
  const fuelConsumption = getUserSetting(userId, 'roadtrip_fuel_consumption');

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
    const distanceMiles = distanceMeters / 1609.344;
    return Math.round((distanceMiles / consumption) * price * 100) / 100;
  }
  const distanceKm = distanceMeters / 1000;
  return Math.round((distanceKm / 100) * consumption * price * 100) / 100;
}

export function syncFuelBudget(tripId: string | number, userId: number): void {
  const dismissed = getUserSetting(userId, `roadtrip_fuel_budget_dismissed_${tripId}`);
  if (dismissed === 'true') return;

  const row = db.prepare(
    'SELECT COALESCE(SUM(fuel_cost), 0) as total FROM trip_route_legs WHERE trip_id = ? AND is_road_trip = 1 AND fuel_cost IS NOT NULL'
  ).get(tripId) as { total: number };
  const totalFuel = Math.round(row.total * 100) / 100;

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

export function recalculateLegs(tripId: string | number, userId: number): void {
  const legs = db.prepare('SELECT id, distance_meters, route_metadata FROM trip_route_legs WHERE trip_id = ? AND distance_meters IS NOT NULL').all(tripId) as { id: number; distance_meters: number; route_metadata: string | null }[];

  const maxSpeedMs = getMaxSpeedMs(userId);
  const updateFuelOnly = db.prepare("UPDATE trip_route_legs SET fuel_cost = ?, updated_at = datetime('now') WHERE id = ?");
  const updateFuelAndDuration = db.prepare("UPDATE trip_route_legs SET fuel_cost = ?, duration_seconds = ?, route_metadata = ?, updated_at = datetime('now') WHERE id = ?");

  const transaction = db.transaction(() => {
    for (const leg of legs) {
      const cost = calculateFuelCost(leg.distance_meters, userId, tripId);

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
        } catch (err) {
          console.error(`Failed to parse route_metadata for leg ${leg.id}:`, err);
        }
      }
      updateFuelOnly.run(cost, leg.id);
    }
  });
  transaction();
}
