import { db } from '../db/database';
import { decrypt_api_key } from './apiKeyCrypto';

export interface FlightInfo {
  flight_number: string;
  airline: string;
  airline_iata: string;
  departure_airport_iata: string;
  departure_airport_name: string;
  departure_terminal: string | null;
  departure_gate: string | null;
  departure_scheduled_local: string | null;
  departure_scheduled_utc: string | null;
  arrival_airport_iata: string;
  arrival_airport_name: string;
  arrival_terminal: string | null;
  arrival_baggage_belt: string | null;
  arrival_scheduled_local: string | null;
  arrival_scheduled_utc: string | null;
  aircraft_type: string | null;
  status: string | null;
}

/**
 * Key resolution priority:
 *   1. process.env.FLIGHT_API_KEY  (set via docker-compose / .env)
 *   2. Calling user's encrypted flight_api_key in DB
 *   3. Admin user's encrypted flight_api_key in DB
 */
function getFlightApiKey(userId: number): string | null {
  if (process.env.FLIGHT_API_KEY?.trim()) return process.env.FLIGHT_API_KEY.trim();

  const user = db.prepare('SELECT flight_api_key FROM users WHERE id = ?').get(userId) as { flight_api_key: string | null } | undefined;
  const userKey = decrypt_api_key(user?.flight_api_key);
  if (userKey) return userKey;

  const admin = db.prepare(
    "SELECT flight_api_key FROM users WHERE role = 'admin' AND flight_api_key IS NOT NULL AND flight_api_key != '' LIMIT 1"
  ).get() as { flight_api_key: string } | undefined;
  return decrypt_api_key(admin?.flight_api_key) || null;
}

/** Returns true if a flight API key is available for the given user. */
export function hasFlightApiKey(userId: number): boolean {
  return !!getFlightApiKey(userId);
}

/**
 * Look up flight information from AeroDataBox.
 * Returns null if the flight is not found (empty response).
 * Throws if the API key is missing, the network fails, or the upstream returns an error.
 */
export async function lookupFlight(
  flightNumber: string,
  date: string, // YYYY-MM-DD
  userId: number
): Promise<FlightInfo | null> {
  const apiKey = getFlightApiKey(userId);
  if (!apiKey) return null;

  // Normalize: remove spaces, uppercase  (e.g. "br 115" → "BR115")
  const normalized = flightNumber.replace(/\s+/g, '').toUpperCase();

  const url = `https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(normalized)}/${date}`;
  const response = await fetch(url, {
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
    },
  });

  if (!response.ok) throw new Error(`AeroDataBox responded with ${response.status}`);

  let data: any[];
  try {
    data = await response.json();
  } catch {
    throw new Error('Invalid JSON response from AeroDataBox');
  }
  if (!Array.isArray(data) || data.length === 0) return null;

  const f = data[0];
  const dep = f.departure ?? {};
  const arr = f.arrival ?? {};

  return {
    flight_number: f.number ?? normalized,
    airline: f.airline?.name ?? '',
    airline_iata: f.airline?.iata ?? '',
    departure_airport_iata: dep.airport?.iata ?? '',
    departure_airport_name: dep.airport?.name ?? dep.airport?.shortName ?? '',
    departure_terminal: dep.terminal ?? null,
    departure_gate: dep.gate ?? null,
    departure_scheduled_local: dep.scheduledTime?.local ?? null,
    departure_scheduled_utc: dep.scheduledTime?.utc ?? null,
    arrival_airport_iata: arr.airport?.iata ?? '',
    arrival_airport_name: arr.airport?.name ?? arr.airport?.shortName ?? '',
    arrival_terminal: arr.terminal ?? null,
    arrival_baggage_belt: arr.baggageBelt ?? null,
    arrival_scheduled_local: arr.scheduledTime?.local ?? null,
    arrival_scheduled_utc: arr.scheduledTime?.utc ?? null,
    aircraft_type: f.aircraft?.model ?? null,
    status: f.status ?? null,
  };
}
