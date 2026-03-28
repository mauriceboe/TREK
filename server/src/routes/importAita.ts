import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { db } from '../db/database';
import { resolveCountryCodeForAirport } from '../data/airportToCountry';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = express.Router();

// Simple in-memory rate limiter: max 10 imports per user per 10 minutes
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 10;
const importAttempts = new Map<number, { count: number; first: number }>();

function importRateLimiter(req: Request, res: Response, next: NextFunction) {
  const userId = (req as AuthRequest).user?.id;
  if (!userId) return next();
  const now = Date.now();
  const record = importAttempts.get(userId);
  if (record && record.count >= RATE_MAX && now - record.first < RATE_WINDOW_MS) {
    return res.status(429).json({ error: 'Too many import attempts. Please try again later.' });
  }
  if (!record || now - record.first >= RATE_WINDOW_MS) {
    importAttempts.set(userId, { count: 1, first: now });
  } else {
    record.count++;
  }
  next();
}

// Store uploaded file in memory (text files are small)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/plain' || file.originalname.endsWith('.txt')) {
      cb(null, true);
    } else {
      // Soft-reject non-text files so this does not surface as a 500 error
      (req as any).fileValidationError = 'Only .txt files are accepted';
      cb(null, false);
    }
  },
});

interface ParsedFlight {
  seat: string | null;
  pnr: string | null;
  seatClass: string | null;
  airlineCode: string | null;
  flightNumber: string | null;
  aircraftType: string | null;
  origin: string | null;
  destination: string | null;
  scheduledDeparture: string | null;
  scheduledArrival: string | null;
}

interface ParsedTrip {
  originAirport: string | null;
  destinationAirport: string | null;
  departureTime: string | null;
  arrivalTime: string | null;
  flights: ParsedFlight[];
}

const MAX_CONNECTION_GAP_MS = 24 * 60 * 60 * 1000;

function normalizeAirport(code: string | null): string | null {
  if (!code) return null;
  const normalized = code.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function toMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function firstFlightDepartureMs(trip: ParsedTrip): number | null {
  let min: number | null = null;
  for (const flight of trip.flights) {
    const ms = toMs(flight.scheduledDeparture);
    if (ms === null) continue;
    min = min === null ? ms : Math.min(min, ms);
  }
  return min;
}

function lastFlightArrivalMs(trip: ParsedTrip): number | null {
  let max: number | null = null;
  for (const flight of trip.flights) {
    const ms = toMs(flight.scheduledArrival);
    if (ms === null) continue;
    max = max === null ? ms : Math.max(max, ms);
  }
  return max;
}

function tripStartMs(trip: ParsedTrip): number | null {
  return toMs(trip.departureTime) ?? firstFlightDepartureMs(trip);
}

function tripEndMs(trip: ParsedTrip): number | null {
  return toMs(trip.arrivalTime) ?? lastFlightArrivalMs(trip);
}

function tripDepartureAirport(trip: ParsedTrip): string | null {
  const fromHeader = normalizeAirport(trip.originAirport);
  if (fromHeader) return fromHeader;
  for (const flight of trip.flights) {
    const fromFlight = normalizeAirport(flight.origin);
    if (fromFlight) return fromFlight;
  }
  return null;
}

function tripArrivalAirport(trip: ParsedTrip): string | null {
  const fromHeader = normalizeAirport(trip.destinationAirport);
  if (fromHeader) return fromHeader;
  for (let i = trip.flights.length - 1; i >= 0; i--) {
    const fromFlight = normalizeAirport(trip.flights[i].destination);
    if (fromFlight) return fromFlight;
  }
  return null;
}

function cloneTrip(trip: ParsedTrip): ParsedTrip {
  return {
    originAirport: trip.originAirport,
    destinationAirport: trip.destinationAirport,
    departureTime: trip.departureTime,
    arrivalTime: trip.arrivalTime,
    flights: [...trip.flights],
  };
}

function shouldStitchTrips(current: ParsedTrip, next: ParsedTrip): boolean {
  const currentArrival = tripArrivalAirport(current);
  const nextDeparture = tripDepartureAirport(next);
  if (!currentArrival || !nextDeparture || currentArrival !== nextDeparture) return false;

  const currentEnd = tripEndMs(current);
  const nextStart = tripStartMs(next);
  if (currentEnd === null || nextStart === null) return false;

  const gap = nextStart - currentEnd;
  return gap >= 0 && gap <= MAX_CONNECTION_GAP_MS;
}

function stitchConnectingTrips(trips: ParsedTrip[]): { trips: ParsedTrip[]; mergedConnections: number } {
  if (trips.length <= 1) return { trips, mergedConnections: 0 };

  const sorted = [...trips].sort((a, b) => {
    const aStart = tripStartMs(a);
    const bStart = tripStartMs(b);
    if (aStart === null && bStart === null) return 0;
    if (aStart === null) return 1;
    if (bStart === null) return -1;
    return aStart - bStart;
  });

  const stitched: ParsedTrip[] = [];
  let mergedConnections = 0;
  let current = cloneTrip(sorted[0]);

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (shouldStitchTrips(current, next)) {
      current = {
        originAirport: current.originAirport ?? next.originAirport,
        destinationAirport: next.destinationAirport ?? current.destinationAirport,
        departureTime: current.departureTime ?? next.departureTime,
        arrivalTime: next.arrivalTime ?? current.arrivalTime,
        flights: [...current.flights, ...next.flights],
      };
      mergedConnections++;
    } else {
      stitched.push(current);
      current = cloneTrip(next);
    }
  }

  stitched.push(current);
  return { trips: stitched, mergedConnections };
}

function nullIfNone(val: string): string | null {
  const trimmed = val.trim();
  return trimmed === 'None' || trimmed === '' ? null : trimmed;
}

/**
 * Parse an App in the Air data.txt export.
 *
 * Relevant file structure (whitespace-stripped lines):
 *   trips:
 *   <tripHeader>      – semicolon-delimited, 8 fields
 *   flights:
 *   <flightRow>       – semicolon-delimited, 17 fields (0-indexed)
 *   ...
 *   hotels:
 *   ...
 *   <blank line>      – separates trips
 */
function parseAitaFile(content: string): ParsedTrip[] {
  const lines = content.split('\n').map(l => l.trimEnd());

  // Fast-forward past everything before 'trips:'
  let i = 0;
  while (i < lines.length && lines[i].trim() !== 'trips:') i++;
  i++; // skip 'trips:' line

  const trips: ParsedTrip[] = [];
  let currentTrip: ParsedTrip | null = null;
  let section: 'header' | 'flights' | 'other' = 'header';

  for (; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === '') {
      // blank line → end of current trip block; also reset section so the
      // next trip header is recognized correctly
      if (currentTrip) {
        trips.push(currentTrip);
        currentTrip = null;
      }
      section = 'header';
      continue;
    }

    if (line === 'flights:') { section = 'flights'; continue; }
    if (line === 'hotels:' || line === 'rental cars:' || line === 'expenses:') {
      section = 'other';
      continue;
    }

    if (section === 'header' && currentTrip === null) {
      // Trip header row: ownership;departureTime;arrivalTime;origin;destination;createdAt;updatedAt;extra
      const parts = line.split(';');
      if (parts.length >= 5) {
        currentTrip = {
          originAirport: nullIfNone(parts[3] ?? ''),
          destinationAirport: nullIfNone(parts[4] ?? ''),
          departureTime: nullIfNone(parts[1] ?? ''),
          arrivalTime: nullIfNone(parts[2] ?? ''),
          flights: [],
        };
      }
      continue;
    }

    if (section === 'flights' && currentTrip !== null && line !== '') {
      // Flight row (17 fields, 0-indexed):
      // 0: id/name, 1: seat, 2: PNR, 3: ?, 4: ?, 5: class, 6: source,
      // 7: airline, 8: flightNum, 9: aircraft, 10: origin, 11: dest,
      // 12: sched.dep, 13: sched.arr, 14: actual.dep, 15: actual.arr, 16: createdAt
      const parts = line.split(';');
      if (parts.length >= 14) {
        currentTrip.flights.push({
          seat: nullIfNone(parts[1] ?? ''),
          pnr: nullIfNone(parts[2] ?? ''),
          seatClass: nullIfNone(parts[5] ?? ''),
          airlineCode: nullIfNone(parts[7] ?? ''),
          flightNumber: nullIfNone(parts[8] ?? ''),
          aircraftType: nullIfNone(parts[9] ?? ''),
          origin: nullIfNone(parts[10] ?? ''),
          destination: nullIfNone(parts[11] ?? ''),
          scheduledDeparture: nullIfNone(parts[12] ?? ''),
          scheduledArrival: nullIfNone(parts[13] ?? ''),
        });
      }
      continue;
    }
  }

  // Handle a trip that wasn't followed by a blank line (end of file)
  if (currentTrip) trips.push(currentTrip);

  return trips;
}

/** Convert an ISO datetime string to a date string (YYYY-MM-DD). */
function toDateStr(iso: string | null): string | null {
  if (!iso) return null;
  return iso.split('T')[0] ?? null;
}

/** Build a human-readable flight title like "EK405: SIN → DXB" */
function flightTitle(f: ParsedFlight): string {
  const airline = f.airlineCode ?? '';
  const num = f.flightNumber ?? '';
  const from = f.origin ?? '???';
  const to = f.destination ?? '???';
  const prefix = airline || num ? `${airline}${num}: ` : '';
  return `${prefix}${from} → ${to}`;
}

function buildTripTitle(trip: ParsedTrip): string {
  const fallbackOrigin = trip.originAirport ?? '???';
  const fallbackDestination = trip.destinationAirport ?? '???';

  if (trip.flights.length === 0) {
    return `${fallbackOrigin} → ${fallbackDestination}`;
  }

  const orderedFlights = [...trip.flights].sort((a, b) => {
    const aMs = toMs(a.scheduledDeparture) ?? Number.MAX_SAFE_INTEGER;
    const bMs = toMs(b.scheduledDeparture) ?? Number.MAX_SAFE_INTEGER;
    return aMs - bMs;
  });

  const route: string[] = [];
  const firstOrigin = normalizeAirport(orderedFlights[0].origin) ?? normalizeAirport(trip.originAirport);
  if (firstOrigin) route.push(firstOrigin);

  for (const flight of orderedFlights) {
    const dest = normalizeAirport(flight.destination);
    if (!dest) continue;
    if (route.length === 0 || route[route.length - 1] !== dest) {
      route.push(dest);
    }
  }

  if (route.length >= 2) {
    return route.join(' → ');
  }

  return `${fallbackOrigin} → ${fallbackDestination}`;
}

router.post('/', authenticate, importRateLimiter, upload.single('file'), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user.id;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  let content: string;
  try {
    content = req.file.buffer.toString('utf-8');
  } catch {
    return res.status(400).json({ error: 'Could not read file as UTF-8 text' });
  }

  let parsedTrips: ParsedTrip[];
  try {
    parsedTrips = parseAitaFile(content);
  } catch {
    return res.status(400).json({ error: 'Failed to parse file' });
  }

  const stitched = stitchConnectingTrips(parsedTrips);
  const tripsForImport = stitched.trips;
  const mergedConnections = stitched.mergedConnections;

  if (tripsForImport.length === 0) {
    return res.status(400).json({ error: 'No trips found in file' });
  }

  // Look up the user's preferred currency from their settings (fallback: EUR)
  const currencySetting = db.prepare(
    "SELECT value FROM settings WHERE user_id = ? AND key = 'currency'"
  ).get(userId) as { value: string } | undefined;
  const userCurrency = currencySetting?.value?.replace(/^"|"$/g, '') || 'EUR';

  const insertTrip = db.prepare(`
    INSERT INTO trips (user_id, title, description, start_date, end_date, currency)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertDay = db.prepare(`
    INSERT INTO days (trip_id, day_number, date) VALUES (?, ?, ?)
  `);

  const insertReservation = db.prepare(`
    INSERT INTO reservations
      (trip_id, title, reservation_time, reservation_end_time, location, confirmation_number, notes, status, type)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 'flight')
  `);

  const insertPlace = db.prepare(`
    INSERT INTO places (trip_id, name, address, reservation_status)
    VALUES (?, ?, ?, 'confirmed')
  `);

  const MS_PER_DAY = 86400000;
  const MAX_TRIP_DAYS = 90;

  /** Insert one day row per calendar date between startDate and endDate. */
  function insertDaysForTrip(tripId: bigint | number, startDate: string | null, endDate: string | null): void {
    if (!startDate) {
      // No dates known – insert a single placeholder day
      insertDay.run(tripId, 1, null);
      return;
    }
    const end = endDate ?? startDate;
    const [sy, sm, sd] = startDate.split('-').map(Number);
    const [ey, em, ed] = end.split('-').map(Number);
    const startMs = Date.UTC(sy, sm - 1, sd);
    const endMs = Date.UTC(ey, em - 1, ed);
    const numDays = Math.min(Math.floor((endMs - startMs) / MS_PER_DAY) + 1, MAX_TRIP_DAYS);
    for (let d = 0; d < numDays; d++) {
      const dayMs = startMs + d * MS_PER_DAY;
      const date = new Date(dayMs);
      const yyyy = date.getUTCFullYear();
      const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(date.getUTCDate()).padStart(2, '0');
      insertDay.run(tripId, d + 1, `${yyyy}-${mm}-${dd}`);
    }
  }

  let importedTrips = 0;
  let importedFlights = 0;
  const unresolvedAirports = new Set<string>();

  const importAll = db.transaction(() => {
    for (const trip of tripsForImport) {
      const title = buildTripTitle(trip);
      const startDate = toDateStr(trip.departureTime);
      const endDate = toDateStr(trip.arrivalTime) ?? startDate;

      const tripResult = insertTrip.run(userId, title, null, startDate, endDate, userCurrency);
      const tripId = tripResult.lastInsertRowid;

      insertDaysForTrip(tripId, startDate, endDate);

      // Insert each flight as a reservation
      for (const flight of trip.flights) {
        const resTitle = flightTitle(flight);
        const location = flight.origin && flight.destination
          ? `${flight.origin} → ${flight.destination}`
          : null;

        const notesParts: string[] = [];
        if (flight.airlineCode && flight.flightNumber)
          notesParts.push(`Flight: ${flight.airlineCode}${flight.flightNumber}`);
        if (flight.aircraftType) notesParts.push(`Aircraft: ${flight.aircraftType}`);
        if (flight.seat) notesParts.push(`Seat: ${flight.seat}`);
        if (flight.seatClass) notesParts.push(`Class: ${flight.seatClass}`);
        const notes = notesParts.length > 0 ? notesParts.join(' · ') : null;

        insertReservation.run(
          tripId,
          resTitle,
          flight.scheduledDeparture,
          flight.scheduledArrival,
          location,
          flight.pnr,
          notes,
        );
        importedFlights++;
      }

      // Create airport places so Atlas can derive visited countries from imported flight data.
      const airportsInTrip = new Set<string>();
      if (trip.originAirport) airportsInTrip.add(trip.originAirport.toUpperCase());
      if (trip.destinationAirport) airportsInTrip.add(trip.destinationAirport.toUpperCase());
      for (const flight of trip.flights) {
        if (flight.origin) airportsInTrip.add(flight.origin.toUpperCase());
        if (flight.destination) airportsInTrip.add(flight.destination.toUpperCase());
      }
      for (const airport of airportsInTrip) {
        const countryCode = resolveCountryCodeForAirport(airport);
        if (!countryCode) {
          unresolvedAirports.add(airport);
          continue;
        }
        insertPlace.run(
          tripId,
          `${airport} Airport`,
          `${airport}, ${countryCode}`,
        );
      }

      importedTrips++;
    }
  });

  try {
    importAll();
  } catch (err: unknown) {
    console.error('AITA import error:', err);
    return res.status(500).json({ error: 'Database error during import' });
  }

  const unresolvedAirportList = [...unresolvedAirports].sort();
  const warnings = unresolvedAirportList.length > 0
    ? [
      `Could not map airport code(s): ${unresolvedAirportList.join(', ')}. Please open a PR to extend AIRPORT_TO_COUNTRY.`,
    ]
    : [];

  return res.json({ importedTrips, importedFlights, mergedConnections, unresolvedAirports: unresolvedAirportList, warnings });
});

export default router;
