import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import { db } from '../db/database';
import { authenticate } from '../middleware/auth';
import { AuthRequest, Trip, Place } from '../types';

const router = express.Router();
router.use(authenticate);

// Geocode cache: rounded coords -> country code
const geocodeCache = new Map<string, string | null>();

function roundKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

async function reverseGeocodeCountry(lat: number, lng: number): Promise<string | null> {
  const key = roundKey(lat, lng);
  if (geocodeCache.has(key)) return geocodeCache.get(key)!;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=3&accept-language=en`, {
      headers: { 'User-Agent': 'TREK Travel Planner' },
    });
    if (!res.ok) return null;
    const data = await res.json() as { address?: { country_code?: string } };
    const code = data.address?.country_code?.toUpperCase() || null;
    geocodeCache.set(key, code);
    return code;
  } catch {
    return null;
  }
}

const COUNTRY_BOXES: Record<string, [number, number, number, number]> = {
  AF:[60.5,29.4,75,38.5],AL:[19,39.6,21.1,42.7],DZ:[-8.7,19,12,37.1],AD:[1.4,42.4,1.8,42.7],AO:[11.7,-18.1,24.1,-4.4],
  AR:[-73.6,-55.1,-53.6,-21.8],AM:[43.4,38.8,46.6,41.3],AU:[112.9,-43.6,153.6,-10.7],AT:[9.5,46.4,17.2,49],AZ:[44.8,38.4,50.4,41.9],
  BD:[88.0,20.7,92.7,26.6],BR:[-73.9,-33.8,-34.8,5.3],BE:[2.5,49.5,6.4,51.5],BG:[22.4,41.2,28.6,44.2],CA:[-141,41.7,-52.6,83.1],CL:[-75.6,-55.9,-66.9,-17.5],
  CN:[73.6,18.2,134.8,53.6],CO:[-79.1,-4.3,-66.9,12.5],HR:[13.5,42.4,19.5,46.6],CZ:[12.1,48.6,18.9,51.1],DK:[8,54.6,15.2,57.8],
  EG:[24.7,22,37,31.7],EE:[21.8,57.5,28.2,59.7],FI:[20.6,59.8,31.6,70.1],FR:[-5.1,41.3,9.6,51.1],DE:[5.9,47.3,15.1,55.1],
  GR:[19.4,34.8,29.7,41.8],HU:[16,45.7,22.9,48.6],IS:[-24.5,63.4,-13.5,66.6],IN:[68.2,6.7,97.4,35.5],ID:[95.3,-11,141,5.9],
  IR:[44.1,25.1,63.3,39.8],IQ:[38.8,29.1,48.6,37.4],IE:[-10.5,51.4,-6,55.4],IL:[34.3,29.5,35.9,33.3],IT:[6.6,36.6,18.5,47.1],
  JP:[129.4,31.1,145.5,45.5],KE:[33.9,-4.7,41.9,5.5],KR:[126,33.2,129.6,38.6],LV:[21,55.7,28.2,58.1],LT:[21,53.9,26.8,56.5],
  LU:[5.7,49.4,6.5,50.2],MY:[99.6,0.9,119.3,7.4],MX:[-118.4,14.5,-86.7,32.7],MA:[-13.2,27.7,-1,35.9],NL:[3.4,50.8,7.2,53.5],
  NZ:[166.4,-47.3,178.5,-34.4],NO:[4.6,58,31.1,71.2],PK:[60.9,23.7,77.1,37.1],PE:[-81.3,-18.4,-68.7,-0.1],PH:[117,5,126.6,18.5],
  PL:[14.1,49,24.1,54.9],PT:[-9.5,36.8,-6.2,42.2],RO:[20.2,43.6,29.7,48.3],RU:[19.6,41.2,180,81.9],SA:[34.6,16.4,55.7,32.2],
  RS:[18.8,42.2,23,46.2],SK:[16.8,47.7,22.6,49.6],SI:[13.4,45.4,16.6,46.9],ZA:[16.5,-34.8,32.9,-22.1],ES:[-9.4,36,-0.2,43.8],
  SE:[11.1,55.3,24.2,69.1],CH:[6,45.8,10.5,47.8],TH:[97.3,5.6,105.6,20.5],TR:[26,36,44.8,42.1],UA:[22.1,44.4,40.2,52.4],
  AE:[51.6,22.6,56.4,26.1],GB:[-8,49.9,2,60.9],US:[-125,24.5,-66.9,49.4],VN:[102.1,8.6,109.5,23.4],
};

function getCountryFromCoords(lat: number, lng: number): string | null {
  let bestCode: string | null = null;
  let bestArea = Infinity;
  for (const [code, [minLng, minLat, maxLng, maxLat]] of Object.entries(COUNTRY_BOXES)) {
    if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) {
      const area = (maxLng - minLng) * (maxLat - minLat);
      if (area < bestArea) {
        bestArea = area;
        bestCode = code;
      }
    }
  }
  return bestCode;
}

const NAME_TO_CODE: Record<string, string> = {
  'germany':'DE','deutschland':'DE','france':'FR','frankreich':'FR','spain':'ES','spanien':'ES',
  'italy':'IT','italien':'IT','united kingdom':'GB','uk':'GB','england':'GB','united states':'US',
  'usa':'US','netherlands':'NL','niederlande':'NL','austria':'AT','osterreich':'AT','switzerland':'CH',
  'schweiz':'CH','portugal':'PT','greece':'GR','griechenland':'GR','turkey':'TR','turkei':'TR',
  'croatia':'HR','kroatien':'HR','czech republic':'CZ','tschechien':'CZ','czechia':'CZ',
  'poland':'PL','polen':'PL','sweden':'SE','schweden':'SE','norway':'NO','norwegen':'NO',
  'denmark':'DK','danemark':'DK','finland':'FI','finnland':'FI','belgium':'BE','belgien':'BE',
  'ireland':'IE','irland':'IE','hungary':'HU','ungarn':'HU','romania':'RO','rumanien':'RO',
  'bulgaria':'BG','bulgarien':'BG','japan':'JP','china':'CN','australia':'AU','australien':'AU',
  'canada':'CA','kanada':'CA','mexico':'MX','mexiko':'MX','brazil':'BR','brasilien':'BR',
  'argentina':'AR','argentinien':'AR','thailand':'TH','indonesia':'ID','indonesien':'ID',
  'india':'IN','indien':'IN','egypt':'EG','agypten':'EG','morocco':'MA','marokko':'MA',
  'south africa':'ZA','sudafrika':'ZA','new zealand':'NZ','neuseeland':'NZ','iceland':'IS','island':'IS',
  'luxembourg':'LU','luxemburg':'LU','slovenia':'SI','slowenien':'SI','slovakia':'SK','slowakei':'SK',
  'estonia':'EE','estland':'EE','latvia':'LV','lettland':'LV','lithuania':'LT','litauen':'LT',
  'serbia':'RS','serbien':'RS','israel':'IL','russia':'RU','russland':'RU','ukraine':'UA',
  'vietnam':'VN','south korea':'KR','sudkorea':'KR','philippines':'PH','philippinen':'PH',
  'malaysia':'MY','colombia':'CO','kolumbien':'CO','peru':'PE','chile':'CL','iran':'IR',
  'iraq':'IQ','irak':'IQ','pakistan':'PK','kenya':'KE','kenia':'KE','nigeria':'NG',
  'saudi arabia':'SA','saudi-arabien':'SA','albania':'AL','albanien':'AL',
};

function getCountryFromAddress(address: string | null): string | null {
  if (!address) return null;
  const parts = address.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];
  const normalized = last.toLowerCase();
  if (NAME_TO_CODE[normalized]) return NAME_TO_CODE[normalized];
  if (NAME_TO_CODE[last]) return NAME_TO_CODE[last];
  if (last.length === 2 && last === last.toUpperCase()) return last;
  return null;
}

const CONTINENT_MAP: Record<string, string> = {
  AF:'Africa',AL:'Europe',DZ:'Africa',AD:'Europe',AO:'Africa',AR:'South America',AM:'Asia',AU:'Oceania',AT:'Europe',AZ:'Asia',
  BR:'South America',BE:'Europe',BG:'Europe',CA:'North America',CL:'South America',CN:'Asia',CO:'South America',HR:'Europe',CZ:'Europe',DK:'Europe',
  EG:'Africa',EE:'Europe',FI:'Europe',FR:'Europe',DE:'Europe',GR:'Europe',HU:'Europe',IS:'Europe',IN:'Asia',ID:'Asia',
  IR:'Asia',IQ:'Asia',IE:'Europe',IL:'Asia',IT:'Europe',JP:'Asia',KE:'Africa',KR:'Asia',LV:'Europe',LT:'Europe',
  LU:'Europe',MY:'Asia',MX:'North America',MA:'Africa',NL:'Europe',NZ:'Oceania',NO:'Europe',PK:'Asia',PE:'South America',PH:'Asia',
  PL:'Europe',PT:'Europe',RO:'Europe',RU:'Europe',SA:'Asia',RS:'Europe',SK:'Europe',SI:'Europe',ZA:'Africa',ES:'Europe',
  SE:'Europe',CH:'Europe',TH:'Asia',TR:'Europe',UA:'Europe',AE:'Asia',GB:'Europe',US:'North America',VN:'Asia',NG:'Africa',
};

router.get('/stats', async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user.id;

  const trips = db.prepare(`
    SELECT DISTINCT t.* FROM trips t
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ?
    WHERE t.user_id = ? OR m.user_id = ?
    ORDER BY t.start_date DESC
  `).all(userId, userId, userId) as Trip[];

  const tripIds = trips.map(t => t.id);
  if (tripIds.length === 0) {
    // Still include manually marked countries even without trips
    const manualCountries = db.prepare('SELECT country_code FROM visited_countries WHERE user_id = ?').all(userId) as { country_code: string }[];
    const countries = manualCountries.map(mc => ({ code: mc.country_code, placeCount: 0, tripCount: 0, firstVisit: null, lastVisit: null }));
    return res.json({ countries, trips: [], stats: { totalTrips: 0, totalPlaces: 0, totalCountries: countries.length, totalDays: 0 } });
  }

  const placeholders = tripIds.map(() => '?').join(',');
  const places = db.prepare(`SELECT * FROM places WHERE trip_id IN (${placeholders})`).all(...tripIds) as Place[];

  interface CountryEntry { code: string; places: { id: number; name: string; lat: number | null; lng: number | null }[]; tripIds: Set<number> }
  const countrySet = new Map<string, CountryEntry>();
  for (const place of places) {
    let code = getCountryFromAddress(place.address);
    if (!code && place.lat && place.lng) {
      code = await reverseGeocodeCountry(place.lat, place.lng);
    }
    if (!code && place.lat && place.lng) {
      code = getCountryFromCoords(place.lat, place.lng);
    }
    if (code) {
      if (!countrySet.has(code)) {
        countrySet.set(code, { code, places: [], tripIds: new Set() });
      }
      countrySet.get(code)!.places.push({ id: place.id, name: place.name, lat: place.lat, lng: place.lng });
      countrySet.get(code)!.tripIds.add(place.trip_id);
    }
  }

  let totalDays = 0;
  for (const trip of trips) {
    if (trip.start_date && trip.end_date) {
      const start = new Date(trip.start_date);
      const end = new Date(trip.end_date);
      const diff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      if (diff > 0) totalDays += diff;
    }
  }

  const countries = [...countrySet.values()].map(c => {
    const countryTrips = trips.filter(t => c.tripIds.has(t.id));
    const dates = countryTrips.map(t => t.start_date).filter(Boolean).sort();
    return {
      code: c.code,
      placeCount: c.places.length,
      tripCount: c.tripIds.size,
      firstVisit: dates[0] || null,
      lastVisit: dates[dates.length - 1] || null,
    };
  });

  const citySet = new Set<string>();
  for (const place of places) {
    if (place.address) {
      const parts = place.address.split(',').map((s: string) => s.trim()).filter(Boolean);
      let raw = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      if (raw) {
        const city = raw.replace(/[\d\-\u2212\u3012]+/g, '').trim().toLowerCase();
        if (city) citySet.add(city);
      }
    }
  }
  const totalCities = citySet.size;

  // Merge manually marked countries
  const manualCountries = db.prepare('SELECT country_code FROM visited_countries WHERE user_id = ?').all(userId) as { country_code: string }[];
  for (const mc of manualCountries) {
    if (!countries.find(c => c.code === mc.country_code)) {
      countries.push({ code: mc.country_code, placeCount: 0, tripCount: 0, firstVisit: null, lastVisit: null });
    }
  }

  const mostVisited = countries.length > 0 ? countries.reduce((a, b) => a.placeCount > b.placeCount ? a : b) : null;

  const continents: Record<string, number> = {};
  countries.forEach(c => {
    const cont = CONTINENT_MAP[c.code] || 'Other';
    continents[cont] = (continents[cont] || 0) + 1;
  });

  const now = new Date().toISOString().split('T')[0];
  const pastTrips = trips.filter(t => t.end_date && t.end_date <= now).sort((a, b) => b.end_date.localeCompare(a.end_date));
  const lastTrip: { id: number; title: string; start_date?: string | null; end_date?: string | null; countryCode?: string } | null = pastTrips[0] ? { id: pastTrips[0].id, title: pastTrips[0].title, start_date: pastTrips[0].start_date, end_date: pastTrips[0].end_date } : null;
  if (lastTrip) {
    const lastTripPlaces = places.filter(p => p.trip_id === lastTrip.id);
    for (const p of lastTripPlaces) {
      let code = getCountryFromAddress(p.address);
      if (!code && p.lat && p.lng) code = getCountryFromCoords(p.lat, p.lng);
      if (code) { lastTrip.countryCode = code; break; }
    }
  }

  const futureTrips = trips.filter(t => t.start_date && t.start_date > now).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const nextTrip: { id: number; title: string; start_date?: string | null; daysUntil?: number } | null = futureTrips[0] ? { id: futureTrips[0].id, title: futureTrips[0].title, start_date: futureTrips[0].start_date } : null;
  if (nextTrip) {
    const diff = Math.ceil((new Date(nextTrip.start_date).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
    nextTrip.daysUntil = Math.max(0, diff);
  }

  const tripYears = new Set(trips.filter(t => t.start_date).map(t => parseInt(t.start_date.split('-')[0])));
  let streak = 0;
  const currentYear = new Date().getFullYear();
  for (let y = currentYear; y >= 2000; y--) {
    if (tripYears.has(y)) streak++;
    else break;
  }
  const firstYear = tripYears.size > 0 ? Math.min(...tripYears) : null;

  res.json({
    countries,
    stats: {
      totalTrips: trips.length,
      totalPlaces: places.length,
      totalCountries: countries.length,
      totalDays,
      totalCities,
    },
    mostVisited,
    continents,
    lastTrip,
    nextTrip,
    streak,
    firstYear,
    tripsThisYear: trips.filter(t => t.start_date && t.start_date.startsWith(String(currentYear))).length,
  });
});

router.get('/country/:code', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user.id;
  const code = req.params.code.toUpperCase();

  const trips = db.prepare(`
    SELECT DISTINCT t.* FROM trips t
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ?
    WHERE t.user_id = ? OR m.user_id = ?
  `).all(userId, userId, userId) as Trip[];

  const tripIds = trips.map(t => t.id);
  if (tripIds.length === 0) return res.json({ places: [], trips: [] });

  const placeholders = tripIds.map(() => '?').join(',');
  const places = db.prepare(`SELECT * FROM places WHERE trip_id IN (${placeholders})`).all(...tripIds) as Place[];

  const matchingPlaces: { id: number; name: string; address: string | null; lat: number | null; lng: number | null; trip_id: number }[] = [];
  const matchingTripIds = new Set<number>();

  for (const place of places) {
    let pCode = getCountryFromAddress(place.address);
    if (!pCode && place.lat && place.lng) pCode = getCountryFromCoords(place.lat, place.lng);
    if (pCode === code) {
      matchingPlaces.push({ id: place.id, name: place.name, address: place.address, lat: place.lat, lng: place.lng, trip_id: place.trip_id });
      matchingTripIds.add(place.trip_id);
    }
  }

  const matchingTrips = trips.filter(t => matchingTripIds.has(t.id)).map(t => ({ id: t.id, title: t.title, start_date: t.start_date, end_date: t.end_date }));

  const isManuallyMarked = !!(db.prepare('SELECT 1 FROM visited_countries WHERE user_id = ? AND country_code = ?').get(userId, code));
  res.json({ places: matchingPlaces, trips: matchingTrips, manually_marked: isManuallyMarked });
});

// Mark/unmark country as visited
router.post('/country/:code/mark', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  db.prepare('INSERT OR IGNORE INTO visited_countries (user_id, country_code) VALUES (?, ?)').run(authReq.user.id, req.params.code.toUpperCase());
  res.json({ success: true });
});

router.delete('/country/:code/mark', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  db.prepare('DELETE FROM visited_countries WHERE user_id = ? AND country_code = ?').run(authReq.user.id, req.params.code.toUpperCase());
  res.json({ success: true });
});

// ── Bucket List ─────────────────────────────────────────────────────────────

router.get('/bucket-list', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const items = db.prepare('SELECT * FROM bucket_list WHERE user_id = ? ORDER BY created_at DESC').all(authReq.user.id);
  res.json({ items });
});

router.post('/bucket-list', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { name, lat, lng, country_code, notes, target_date } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  const result = db.prepare('INSERT INTO bucket_list (user_id, name, lat, lng, country_code, notes, target_date) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    authReq.user.id, name.trim(), lat ?? null, lng ?? null, country_code ?? null, notes ?? null, target_date ?? null
  );
  const item = db.prepare('SELECT * FROM bucket_list WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ item });
});

router.put('/bucket-list/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { name, notes, lat, lng, country_code, target_date } = req.body;
  const item = db.prepare('SELECT * FROM bucket_list WHERE id = ? AND user_id = ?').get(req.params.id, authReq.user.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  db.prepare(`UPDATE bucket_list SET
    name = COALESCE(?, name),
    notes = CASE WHEN ? THEN ? ELSE notes END,
    lat = CASE WHEN ? THEN ? ELSE lat END,
    lng = CASE WHEN ? THEN ? ELSE lng END,
    country_code = CASE WHEN ? THEN ? ELSE country_code END,
    target_date = CASE WHEN ? THEN ? ELSE target_date END
    WHERE id = ?`).run(
    name?.trim() || null,
    notes !== undefined ? 1 : 0, notes !== undefined ? (notes || null) : null,
    lat !== undefined ? 1 : 0, lat !== undefined ? (lat || null) : null,
    lng !== undefined ? 1 : 0, lng !== undefined ? (lng || null) : null,
    country_code !== undefined ? 1 : 0, country_code !== undefined ? (country_code || null) : null,
    target_date !== undefined ? 1 : 0, target_date !== undefined ? (target_date || null) : null,
    req.params.id
  );
  res.json({ item: db.prepare('SELECT * FROM bucket_list WHERE id = ?').get(req.params.id) });
});

router.delete('/bucket-list/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const item = db.prepare('SELECT * FROM bucket_list WHERE id = ? AND user_id = ?').get(req.params.id, authReq.user.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  db.prepare('DELETE FROM bucket_list WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

export default router;
