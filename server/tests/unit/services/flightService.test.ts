import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock DB to avoid module-level db.prepare issues
vi.mock('../../../src/db/database', () => ({
  db: {
    prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(null) }),
  },
}));

vi.mock('../../../src/services/apiKeyCrypto', () => ({
  decrypt_api_key: vi.fn((key: string | null | undefined) => key || null),
}));

// Must be imported after mocks
import { lookupFlight } from '../../../src/services/flightService';
import { db } from '../../../src/db/database';
import { decrypt_api_key } from '../../../src/services/apiKeyCrypto';

const mockDb = db as any;
const mockDecrypt = decrypt_api_key as any;

const MOCK_AERODATABOX_RESPONSE = [
  {
    number: 'BR115',
    airline: { name: 'EVA Air', iata: 'BR' },
    departure: {
      airport: { iata: 'TPE', name: 'Taoyuan International Airport' },
      terminal: '2',
      gate: 'D5',
      scheduledTime: { local: '2026-04-06T08:00:00+08:00', utc: '2026-04-06T00:00:00Z' },
    },
    arrival: {
      airport: { iata: 'NRT', name: 'Narita International Airport' },
      terminal: '1',
      baggageBelt: '7',
      scheduledTime: { local: '2026-04-06T12:30:00+09:00', utc: '2026-04-06T03:30:00Z' },
    },
    aircraft: { model: 'Boeing 787-10' },
    status: 'Scheduled',
  },
];

function mockFetch(status: number, body: any, ok?: boolean) {
  const isOk = ok ?? (status >= 200 && status < 300);
  global.fetch = vi.fn().mockResolvedValueOnce({
    ok: isOk,
    status,
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.FLIGHT_API_KEY;
  mockDb.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(null) });
  mockDecrypt.mockImplementation((key: string | null) => key || null);
});

afterEach(() => {
  delete process.env.FLIGHT_API_KEY;
});

// ── getFlightApiKey resolution ───────────────────────────────────────────────

describe('getFlightApiKey resolution', () => {
  it('uses FLIGHT_API_KEY env var when set', async () => {
    process.env.FLIGHT_API_KEY = 'env-api-key';
    mockFetch(200, MOCK_AERODATABOX_RESPONSE);

    const result = await lookupFlight('BR115', '2026-04-06', 1);

    expect(result).not.toBeNull();
    expect((global.fetch as any).mock.calls[0][1].headers['x-rapidapi-key']).toBe('env-api-key');
  });

  it('uses user DB key when env var not set', async () => {
    mockDb.prepare.mockReturnValueOnce({
      get: vi.fn().mockReturnValue({ flight_api_key: 'user-key' }),
    });
    mockDecrypt.mockReturnValueOnce('user-key');
    mockFetch(200, MOCK_AERODATABOX_RESPONSE);

    const result = await lookupFlight('BR115', '2026-04-06', 42);

    expect(result).not.toBeNull();
    expect((global.fetch as any).mock.calls[0][1].headers['x-rapidapi-key']).toBe('user-key');
  });

  it('falls back to admin DB key when user has none', async () => {
    // First call: user lookup returns null key
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ flight_api_key: null }) })
      // Second call: admin lookup
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ flight_api_key: 'admin-key' }) });
    mockDecrypt
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('admin-key');
    mockFetch(200, MOCK_AERODATABOX_RESPONSE);

    const result = await lookupFlight('BR115', '2026-04-06', 1);
    expect(result).not.toBeNull();
    expect((global.fetch as any).mock.calls[0][1].headers['x-rapidapi-key']).toBe('admin-key');
  });

  it('returns null when no API key is available', async () => {
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(null) })
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(null) });
    mockDecrypt.mockReturnValue(null);

    const fetchBefore = global.fetch as ReturnType<typeof vi.fn> | undefined;
    const callsBefore = fetchBefore ? fetchBefore.mock.calls.length : 0;

    const result = await lookupFlight('BR115', '2026-04-06', 1);
    expect(result).toBeNull();
    // fetch must NOT have been called
    if (global.fetch) {
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    }
  });
});

// ── flight number normalization ──────────────────────────────────────────────

describe('flight number normalization', () => {
  beforeEach(() => {
    process.env.FLIGHT_API_KEY = 'test-key';
    mockFetch(200, MOCK_AERODATABOX_RESPONSE);
  });

  it('normalizes lowercase to uppercase', async () => {
    await lookupFlight('br115', '2026-04-06', 1);
    expect((global.fetch as any).mock.calls[0][0]).toContain('BR115');
  });

  it('normalizes with space "BR 115" → "BR115"', async () => {
    await lookupFlight('BR 115', '2026-04-06', 1);
    expect((global.fetch as any).mock.calls[0][0]).toContain('BR115');
  });

  it('normalizes multiple spaces "B R 1 1 5" → "BR115"', async () => {
    await lookupFlight('B R 1 1 5', '2026-04-06', 1);
    expect((global.fetch as any).mock.calls[0][0]).toContain('BR115');
  });

  it('already normalized "BR115" stays "BR115"', async () => {
    await lookupFlight('BR115', '2026-04-06', 1);
    expect((global.fetch as any).mock.calls[0][0]).toContain('BR115');
  });
});

// ── successful lookup ────────────────────────────────────────────────────────

describe('lookupFlight — successful response', () => {
  beforeEach(() => {
    process.env.FLIGHT_API_KEY = 'test-key';
  });

  it('maps all fields from AeroDataBox response', async () => {
    mockFetch(200, MOCK_AERODATABOX_RESPONSE);
    const result = await lookupFlight('BR115', '2026-04-06', 1);

    expect(result).not.toBeNull();
    expect(result!.flight_number).toBe('BR115');
    expect(result!.airline).toBe('EVA Air');
    expect(result!.airline_iata).toBe('BR');
    expect(result!.departure_airport_iata).toBe('TPE');
    expect(result!.departure_airport_name).toBe('Taoyuan International Airport');
    expect(result!.departure_terminal).toBe('2');
    expect(result!.departure_gate).toBe('D5');
    expect(result!.departure_scheduled_local).toBe('2026-04-06T08:00:00+08:00');
    expect(result!.departure_scheduled_utc).toBe('2026-04-06T00:00:00Z');
    expect(result!.arrival_airport_iata).toBe('NRT');
    expect(result!.arrival_airport_name).toBe('Narita International Airport');
    expect(result!.arrival_terminal).toBe('1');
    expect(result!.arrival_baggage_belt).toBe('7');
    expect(result!.arrival_scheduled_local).toBe('2026-04-06T12:30:00+09:00');
    expect(result!.arrival_scheduled_utc).toBe('2026-04-06T03:30:00Z');
    expect(result!.aircraft_type).toBe('Boeing 787-10');
    expect(result!.status).toBe('Scheduled');
  });

  it('uses f.number from response, not the normalized input', async () => {
    mockFetch(200, [{ ...MOCK_AERODATABOX_RESPONSE[0], number: 'BR0115' }]);
    const result = await lookupFlight('BR115', '2026-04-06', 1);
    expect(result!.flight_number).toBe('BR0115');
  });

  it('uses normalized flightNumber when f.number is missing', async () => {
    const noNumber = { ...MOCK_AERODATABOX_RESPONSE[0] };
    delete (noNumber as any).number;
    mockFetch(200, [noNumber]);
    const result = await lookupFlight('br115', '2026-04-06', 1);
    expect(result!.flight_number).toBe('BR115');
  });

  it('handles missing optional fields gracefully (nulls)', async () => {
    mockFetch(200, [{
      number: 'JL001',
      airline: { name: 'Japan Airlines', iata: 'JL' },
      departure: { airport: { iata: 'NRT', name: 'Narita' } },
      arrival: { airport: { iata: 'LAX', name: 'Los Angeles' } },
    }]);
    const result = await lookupFlight('JL001', '2026-04-06', 1);

    expect(result).not.toBeNull();
    expect(result!.departure_terminal).toBeNull();
    expect(result!.departure_gate).toBeNull();
    expect(result!.departure_scheduled_local).toBeNull();
    expect(result!.arrival_terminal).toBeNull();
    expect(result!.arrival_baggage_belt).toBeNull();
    expect(result!.aircraft_type).toBeNull();
    expect(result!.status).toBeNull();
  });

  it('uses shortName as fallback for airport name', async () => {
    mockFetch(200, [{
      number: 'AA001',
      airline: { name: 'American Airlines', iata: 'AA' },
      departure: { airport: { iata: 'JFK', shortName: 'JFK Airport' } },
      arrival: { airport: { iata: 'LAX', shortName: 'LAX Airport' } },
    }]);
    const result = await lookupFlight('AA001', '2026-04-06', 1);
    expect(result!.departure_airport_name).toBe('JFK Airport');
    expect(result!.arrival_airport_name).toBe('LAX Airport');
  });

  it('calls correct AeroDataBox URL with date', async () => {
    mockFetch(200, MOCK_AERODATABOX_RESPONSE);
    await lookupFlight('BR115', '2026-04-07', 1);
    expect((global.fetch as any).mock.calls[0][0]).toBe(
      'https://aerodatabox.p.rapidapi.com/flights/number/BR115/2026-04-07'
    );
  });

  it('sets correct RapidAPI host header', async () => {
    mockFetch(200, MOCK_AERODATABOX_RESPONSE);
    await lookupFlight('BR115', '2026-04-06', 1);
    const headers = (global.fetch as any).mock.calls[0][1].headers;
    expect(headers['x-rapidapi-host']).toBe('aerodatabox.p.rapidapi.com');
  });
});

// ── error handling ───────────────────────────────────────────────────────────

describe('lookupFlight — error handling', () => {
  beforeEach(() => {
    process.env.FLIGHT_API_KEY = 'test-key';
  });

  it('returns null for HTTP 404', async () => {
    mockFetch(404, { message: 'Not Found' }, false);
    await expect(lookupFlight('XX999', '2026-04-06', 1)).rejects.toThrow();
  });

  it('returns null for HTTP 403 (bad key)', async () => {
    mockFetch(403, { message: 'Forbidden' }, false);
    await expect(lookupFlight('BR115', '2026-04-06', 1)).rejects.toThrow();
  });

  it('returns null for HTTP 429 (rate limit)', async () => {
    mockFetch(429, { message: 'Too Many Requests' }, false);
    await expect(lookupFlight('BR115', '2026-04-06', 1)).rejects.toThrow();
  });

  it('throws when fetch throws a network error', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));
    await expect(lookupFlight('BR115', '2026-04-06', 1)).rejects.toThrow('Network error');
  });

  it('returns null for empty array response (flight not found)', async () => {
    mockFetch(200, []);
    expect(await lookupFlight('BR115', '2026-04-06', 1)).toBeNull();
  });

  it('throws for invalid JSON response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    });
    await expect(lookupFlight('BR115', '2026-04-06', 1)).rejects.toThrow();
  });

  it('returns null for non-array response', async () => {
    mockFetch(200, { error: 'unexpected object' });
    expect(await lookupFlight('BR115', '2026-04-06', 1)).toBeNull();
  });

  it('returns null for null response', async () => {
    mockFetch(200, null);
    expect(await lookupFlight('BR115', '2026-04-06', 1)).toBeNull();
  });
});
