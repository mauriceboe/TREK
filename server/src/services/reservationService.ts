import { db, canAccessTrip } from '../db/database';
import { Reservation } from '../types';

export interface ReservationEndpoint {
  id?: number;
  reservation_id?: number;
  role: 'from' | 'to' | 'stop';
  sequence: number;
  name: string;
  code: string | null;
  lat: number;
  lng: number;
  timezone: string | null;
  local_time: string | null;
  local_date: string | null;
}

type EndpointInput = Omit<ReservationEndpoint, 'id' | 'reservation_id' | 'sequence'> & { sequence?: number };

export function verifyTripAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

function loadEndpointsByTrip(tripId: string | number): Map<number, ReservationEndpoint[]> {
  const rows = db.prepare(`
    SELECT e.* FROM reservation_endpoints e
    JOIN reservations r ON e.reservation_id = r.id
    WHERE r.trip_id = ?
    ORDER BY e.reservation_id, e.sequence
  `).all(tripId) as ReservationEndpoint[];
  const map = new Map<number, ReservationEndpoint[]>();
  for (const r of rows) {
    const list = map.get(r.reservation_id!) ?? [];
    list.push(r);
    map.set(r.reservation_id!, list);
  }
  return map;
}

function loadEndpoints(reservationId: number): ReservationEndpoint[] {
  return db.prepare(
    'SELECT * FROM reservation_endpoints WHERE reservation_id = ? ORDER BY sequence'
  ).all(reservationId) as ReservationEndpoint[];
}

// Resolve the day row whose date matches the date portion of an ISO-ish
// timestamp. Used to keep `day_id` / `end_day_id` in sync with
// `reservation_time` / `reservation_end_time` so non-transport bookings
// (tours, restaurants, events, ...) end up on the right day in the UI,
// which now filters by day_id instead of reservation_time.
function resolveDayIdFromTime(
  tripId: string | number,
  time: string | null | undefined,
): number | null {
  if (!time) return null;
  const datePart = time.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  const row = db
    .prepare('SELECT id FROM days WHERE trip_id = ? AND date = ? LIMIT 1')
    .get(tripId, datePart) as { id: number } | undefined;
  return row?.id ?? null;
}

function saveEndpoints(reservationId: number, endpoints: EndpointInput[]): void {
  // Bind the transaction lazily on each call. Binding at module load time
  // captures the DB connection that was open then, which becomes invalid
  // after demo-reset / restore-from-backup closes and reinitialises the
  // connection — every later endpoint save would throw
  // "The database connection is not open".
  const tx = db.transaction((rid: number, eps: EndpointInput[]) => {
    db.prepare('DELETE FROM reservation_endpoints WHERE reservation_id = ?').run(rid);
    const insert = db.prepare(`
      INSERT INTO reservation_endpoints (reservation_id, role, sequence, name, code, lat, lng, timezone, local_time, local_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    eps.forEach((e, i) => {
      insert.run(rid, e.role, e.sequence ?? i, e.name, e.code ?? null, e.lat, e.lng, e.timezone ?? null, e.local_time ?? null, e.local_date ?? null);
    });
  });
  tx(reservationId, endpoints);
}

export function listReservations(tripId: string | number) {
  const reservations = db.prepare(`
    SELECT r.*, d.day_number, p.name as place_name, r.assignment_id,
      ap.place_id as accommodation_place_id, acc_p.name as accommodation_name,
      ap.start_day_id as accommodation_start_day_id, ap.end_day_id as accommodation_end_day_id
    FROM reservations r
    LEFT JOIN days d ON r.day_id = d.id
    LEFT JOIN places p ON r.place_id = p.id
    LEFT JOIN day_accommodations ap ON r.accommodation_id = ap.id
    LEFT JOIN places acc_p ON ap.place_id = acc_p.id
    WHERE r.trip_id = ?
    ORDER BY r.reservation_time ASC, r.created_at ASC
  `).all(tripId) as any[];

  const dayPositions = db.prepare(`
    SELECT rdp.reservation_id, rdp.day_id, rdp.position
    FROM reservation_day_positions rdp
    JOIN reservations r ON rdp.reservation_id = r.id
    WHERE r.trip_id = ?
  `).all(tripId) as { reservation_id: number; day_id: number; position: number }[];

  const posMap = new Map<number, Record<number, number>>();
  for (const dp of dayPositions) {
    if (!posMap.has(dp.reservation_id)) posMap.set(dp.reservation_id, {});
    posMap.get(dp.reservation_id)![dp.day_id] = dp.position;
  }

  const endpointsMap = loadEndpointsByTrip(tripId);

  for (const r of reservations) {
    r.day_positions = posMap.get(r.id) || null;
    r.endpoints = endpointsMap.get(r.id) || [];
  }

  return reservations;
}

export function getReservationWithJoins(id: string | number) {
  const row = db.prepare(`
    SELECT r.*, d.day_number, p.name as place_name, r.assignment_id,
      ap.place_id as accommodation_place_id, acc_p.name as accommodation_name,
      ap.start_day_id as accommodation_start_day_id, ap.end_day_id as accommodation_end_day_id
    FROM reservations r
    LEFT JOIN days d ON r.day_id = d.id
    LEFT JOIN places p ON r.place_id = p.id
    LEFT JOIN day_accommodations ap ON r.accommodation_id = ap.id
    LEFT JOIN places acc_p ON ap.place_id = acc_p.id
    WHERE r.id = ?
  `).get(id) as any;
  if (!row) return undefined;
  row.endpoints = loadEndpoints(row.id);
  return row;
}

interface CreateAccommodation {
  place_id?: number;
  start_day_id?: number;
  end_day_id?: number;
  check_in?: string;
  check_out?: string;
  confirmation?: string;
}

interface CreateReservationData {
  title: string;
  reservation_time?: string;
  reservation_end_time?: string;
  location?: string;
  confirmation_number?: string;
  notes?: string;
  day_id?: number;
  end_day_id?: number;
  place_id?: number;
  assignment_id?: number;
  status?: string;
  type?: string;
  accommodation_id?: number;
  metadata?: any;
  create_accommodation?: CreateAccommodation;
  endpoints?: EndpointInput[];
  needs_review?: boolean;
}

export function createReservation(tripId: string | number, data: CreateReservationData): { reservation: any; accommodationCreated: boolean } {
  const {
    title, reservation_time, reservation_end_time, location,
    confirmation_number, notes, day_id, end_day_id, place_id, assignment_id,
    status, type, accommodation_id, metadata, create_accommodation,
    endpoints, needs_review
  } = data;

  let accommodationCreated = false;

  // Auto-create accommodation for hotel reservations
  let resolvedAccommodationId: number | null = accommodation_id || null;
  if (type === 'hotel' && !resolvedAccommodationId && create_accommodation) {
    const { place_id: accPlaceId, start_day_id, end_day_id, check_in, check_out, confirmation: accConf } = create_accommodation;
    if (start_day_id && end_day_id) {
      const accResult = db.prepare(
        'INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out, confirmation) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(tripId, accPlaceId || null, start_day_id, end_day_id, check_in || null, check_out || null, accConf || confirmation_number || null);
      resolvedAccommodationId = Number(accResult.lastInsertRowid);
      accommodationCreated = true;
    }
  }

  // Derive day_id / end_day_id from reservation_time when the client
  // didn't explicitly set them (non-hotel bookings only — hotels store
  // their date range on the linked day_accommodation).
  const resolvedType = type || 'other';
  let resolvedDayId: number | null = day_id ?? null;
  if (resolvedDayId == null && resolvedType !== 'hotel' && reservation_time) {
    resolvedDayId = resolveDayIdFromTime(tripId, reservation_time);
  }
  let resolvedEndDayId: number | null = end_day_id ?? null;
  if (resolvedEndDayId == null && resolvedType !== 'hotel' && reservation_end_time) {
    resolvedEndDayId = resolveDayIdFromTime(tripId, reservation_end_time);
  }

  const result = db.prepare(`
    INSERT INTO reservations (trip_id, day_id, end_day_id, place_id, assignment_id, title, reservation_time, reservation_end_time, location, confirmation_number, notes, status, type, accommodation_id, metadata, needs_review)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tripId,
    resolvedDayId,
    resolvedEndDayId,
    place_id || null,
    assignment_id || null,
    title,
    reservation_time || null,
    reservation_end_time || null,
    location || null,
    confirmation_number || null,
    notes || null,
    status || 'pending',
    resolvedType,
    resolvedAccommodationId,
    metadata ? JSON.stringify(metadata) : null,
    needs_review ? 1 : 0
  );

  if (endpoints && endpoints.length > 0) {
    saveEndpoints(Number(result.lastInsertRowid), endpoints);
  }

  // Sync check-in/out to accommodation if linked
  if (accommodation_id && metadata) {
    const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    if (meta.check_in_time || meta.check_in_end_time || meta.check_out_time) {
      db.prepare('UPDATE day_accommodations SET check_in = COALESCE(?, check_in), check_in_end = COALESCE(?, check_in_end), check_out = COALESCE(?, check_out) WHERE id = ?')
        .run(meta.check_in_time || null, meta.check_in_end_time || null, meta.check_out_time || null, accommodation_id);
    }
    if (confirmation_number) {
      db.prepare('UPDATE day_accommodations SET confirmation = COALESCE(?, confirmation) WHERE id = ?')
        .run(confirmation_number, accommodation_id);
    }
  }

  const reservation = getReservationWithJoins(Number(result.lastInsertRowid));
  return { reservation, accommodationCreated };
}

export function updatePositions(tripId: string | number, positions: { id: number; day_plan_position: number }[], dayId?: number | string) {
  if (dayId) {
    // Per-day positions for multi-day reservations
    const stmt = db.prepare('INSERT OR REPLACE INTO reservation_day_positions (reservation_id, day_id, position) VALUES (?, ?, ?)');
    const updateMany = db.transaction((items: { id: number; day_plan_position: number }[]) => {
      for (const item of items) {
        stmt.run(item.id, dayId, item.day_plan_position);
      }
    });
    updateMany(positions);
  } else {
    // Legacy: update global position
    const stmt = db.prepare('UPDATE reservations SET day_plan_position = ? WHERE id = ? AND trip_id = ?');
    const updateMany = db.transaction((items: { id: number; day_plan_position: number }[]) => {
      for (const item of items) {
        stmt.run(item.day_plan_position, item.id, tripId);
      }
    });
    updateMany(positions);
  }
}

export function getDayPositions(tripId: string | number, dayId: number | string) {
  return db.prepare(`
    SELECT rdp.reservation_id, rdp.position
    FROM reservation_day_positions rdp
    JOIN reservations r ON rdp.reservation_id = r.id
    WHERE r.trip_id = ? AND rdp.day_id = ?
  `).all(tripId, dayId) as { reservation_id: number; position: number }[];
}

export function getReservation(id: string | number, tripId: string | number) {
  return db.prepare('SELECT * FROM reservations WHERE id = ? AND trip_id = ?').get(id, tripId) as Reservation | undefined;
}

interface UpdateReservationData {
  title?: string;
  reservation_time?: string;
  reservation_end_time?: string;
  location?: string;
  confirmation_number?: string;
  notes?: string;
  day_id?: number;
  end_day_id?: number | null;
  place_id?: number;
  assignment_id?: number;
  status?: string;
  type?: string;
  accommodation_id?: number;
  metadata?: any;
  create_accommodation?: CreateAccommodation;
  endpoints?: EndpointInput[];
  needs_review?: boolean;
}

export function updateReservation(id: string | number, tripId: string | number, data: UpdateReservationData, current: Reservation): { reservation: any; accommodationChanged: boolean } {
  const {
    title, reservation_time, reservation_end_time, location,
    confirmation_number, notes, day_id, end_day_id, place_id, assignment_id,
    status, type, accommodation_id, metadata, create_accommodation,
    endpoints, needs_review
  } = data;

  let accommodationChanged = false;

  // Update or create accommodation for hotel reservations
  let resolvedAccId: number | null = accommodation_id !== undefined ? (accommodation_id || null) : (current.accommodation_id ?? null);
  if (resolvedAccId) {
    const accExists = db.prepare('SELECT id FROM day_accommodations WHERE id = ?').get(resolvedAccId);
    if (!accExists) resolvedAccId = null;
  }
  if (type === 'hotel' && create_accommodation) {
    const { place_id: accPlaceId, start_day_id, end_day_id, check_in, check_out, confirmation: accConf } = create_accommodation;
    if (start_day_id && end_day_id) {
      if (resolvedAccId) {
        db.prepare('UPDATE day_accommodations SET place_id = ?, start_day_id = ?, end_day_id = ?, check_in = ?, check_out = ?, confirmation = ? WHERE id = ?')
          .run(accPlaceId || null, start_day_id, end_day_id, check_in || null, check_out || null, accConf || confirmation_number || null, resolvedAccId);
      } else if (accPlaceId) {
        const accResult = db.prepare(
          'INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out, confirmation) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(tripId, accPlaceId, start_day_id, end_day_id, check_in || null, check_out || null, accConf || confirmation_number || null);
        resolvedAccId = Number(accResult.lastInsertRowid);
      }
      accommodationChanged = true;
    }
  }

  const resolvedType = (type ?? current.type) || 'other';
  const nextReservationTime = resolvedType === 'hotel'
    ? null
    : (reservation_time !== undefined ? (reservation_time || null) : current.reservation_time);
  const nextReservationEndTime = resolvedType === 'hotel'
    ? null
    : (reservation_end_time !== undefined ? (reservation_end_time || null) : current.reservation_end_time);

  // day_id / end_day_id: honour an explicit value from the client,
  // otherwise derive from the (possibly updated) reservation_time so the
  // planner renders the booking on the correct day.
  let nextDayId: number | null;
  if (day_id !== undefined) {
    nextDayId = day_id || null;
  } else if (reservation_time !== undefined && resolvedType !== 'hotel') {
    nextDayId = resolveDayIdFromTime(tripId, nextReservationTime);
  } else {
    nextDayId = current.day_id ?? null;
  }

  let nextEndDayId: number | null;
  if (end_day_id !== undefined) {
    nextEndDayId = end_day_id ?? null;
  } else if (reservation_end_time !== undefined && resolvedType !== 'hotel') {
    nextEndDayId = resolveDayIdFromTime(tripId, nextReservationEndTime);
  } else {
    nextEndDayId = (current as any).end_day_id ?? null;
  }

  db.prepare(`
    UPDATE reservations SET
      title = COALESCE(?, title),
      reservation_time = ?,
      reservation_end_time = ?,
      location = ?,
      confirmation_number = ?,
      notes = ?,
      day_id = ?,
      end_day_id = ?,
      place_id = ?,
      assignment_id = ?,
      status = COALESCE(?, status),
      type = COALESCE(?, type),
      accommodation_id = ?,
      metadata = ?,
      needs_review = COALESCE(?, needs_review)
    WHERE id = ?
  `).run(
    title || null,
    nextReservationTime,
    nextReservationEndTime,
    location !== undefined ? (location || null) : current.location,
    confirmation_number !== undefined ? (confirmation_number || null) : current.confirmation_number,
    notes !== undefined ? (notes || null) : current.notes,
    nextDayId,
    nextEndDayId,
    place_id !== undefined ? (place_id || null) : current.place_id,
    assignment_id !== undefined ? (assignment_id || null) : current.assignment_id,
    status || null,
    type || null,
    resolvedAccId,
    metadata !== undefined ? (metadata ? JSON.stringify(metadata) : null) : current.metadata,
    needs_review === undefined ? null : (needs_review ? 1 : 0),
    id
  );

  if (endpoints !== undefined) {
    saveEndpoints(Number(id), endpoints);
  }

  // Sync check-in/out to accommodation if linked
  const resolvedMeta = metadata !== undefined ? metadata : (current.metadata ? JSON.parse(current.metadata as string) : null);
  if (resolvedAccId && resolvedMeta) {
    const meta = typeof resolvedMeta === 'string' ? JSON.parse(resolvedMeta) : resolvedMeta;
    if (meta.check_in_time || meta.check_in_end_time || meta.check_out_time) {
      db.prepare('UPDATE day_accommodations SET check_in = COALESCE(?, check_in), check_in_end = COALESCE(?, check_in_end), check_out = COALESCE(?, check_out) WHERE id = ?')
        .run(meta.check_in_time || null, meta.check_in_end_time || null, meta.check_out_time || null, resolvedAccId);
    }
    const resolvedConf = confirmation_number !== undefined ? confirmation_number : current.confirmation_number;
    if (resolvedConf) {
      db.prepare('UPDATE day_accommodations SET confirmation = COALESCE(?, confirmation) WHERE id = ?')
        .run(resolvedConf, resolvedAccId);
    }
  }

  const reservation = getReservationWithJoins(id);
  return { reservation, accommodationChanged };
}

export function deleteReservation(id: string | number, tripId: string | number): { deleted: { id: number; title: string; type: string; accommodation_id: number | null } | undefined; accommodationDeleted: boolean } {
  const reservation = db.prepare('SELECT id, title, type, accommodation_id FROM reservations WHERE id = ? AND trip_id = ?').get(id, tripId) as { id: number; title: string; type: string; accommodation_id: number | null } | undefined;
  if (!reservation) return { deleted: undefined, accommodationDeleted: false };

  let accommodationDeleted = false;
  if (reservation.accommodation_id) {
    db.prepare('DELETE FROM day_accommodations WHERE id = ?').run(reservation.accommodation_id);
    accommodationDeleted = true;
  }

  db.prepare('DELETE FROM reservations WHERE id = ?').run(id);
  return { deleted: reservation, accommodationDeleted };
}
