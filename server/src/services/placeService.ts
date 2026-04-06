import { XMLParser } from 'fast-xml-parser';
import { db, getPlaceWithTags } from '../db/database';
import { loadTagsByPlaceIds } from './queryHelpers';
import { Place } from '../types';

interface PlaceWithCategory extends Place {
  category_name: string | null;
  category_color: string | null;
  category_icon: string | null;
}

interface UnsplashSearchResponse {
  results?: { id: string; urls?: { regular?: string; thumb?: string }; description?: string; alt_description?: string; user?: { name?: string }; links?: { html?: string } }[];
  errors?: string[];
}

// ---------------------------------------------------------------------------
// List places
// ---------------------------------------------------------------------------

export function listPlaces(
  tripId: string,
  filters: { search?: string; category?: string; tag?: string; assignment?: 'all' | 'unassigned' | 'assigned' },
) {
  let query = `
    SELECT DISTINCT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM places p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.trip_id = ?
  `;
  const params: (string | number)[] = [tripId];

  if (filters.search) {
    query += ' AND (p.name LIKE ? OR p.address LIKE ? OR p.description LIKE ?)';
    const searchParam = `%${filters.search}%`;
    params.push(searchParam, searchParam, searchParam);
  }

  if (filters.category) {
    query += ' AND p.category_id = ?';
    params.push(filters.category);
  }

  if (filters.tag) {
    query += ' AND p.id IN (SELECT place_id FROM place_tags WHERE tag_id = ?)';
    params.push(filters.tag);
  }

  if (filters.assignment === 'unassigned') {
    query += ` AND p.id NOT IN (SELECT da.place_id FROM day_assignments da JOIN days d ON da.day_id = d.id WHERE d.trip_id = ?)`;
    params.push(tripId);
  } else if (filters.assignment === 'assigned') {
    query += ` AND p.id IN (SELECT da.place_id FROM day_assignments da JOIN days d ON da.day_id = d.id WHERE d.trip_id = ?)`;
    params.push(tripId);
  }

  query += ' ORDER BY p.created_at DESC';

  const places = db.prepare(query).all(...params) as PlaceWithCategory[];

  const placeIds = places.map(p => p.id);
  const tagsByPlaceId = loadTagsByPlaceIds(placeIds);

  return places.map(p => ({
    ...p,
    category: p.category_id ? {
      id: p.category_id,
      name: p.category_name,
      color: p.category_color,
      icon: p.category_icon,
    } : null,
    tags: tagsByPlaceId[p.id] || [],
  }));
}

// ---------------------------------------------------------------------------
// Create place
// ---------------------------------------------------------------------------

export function createPlace(
  tripId: string,
  body: {
    name: string; description?: string; lat?: number; lng?: number; address?: string;
    category_id?: number; price?: number; currency?: string;
    place_time?: string; end_time?: string;
    duration_minutes?: number; notes?: string; image_url?: string;
    google_place_id?: string; osm_id?: string; website?: string; phone?: string;
    transport_mode?: string; tags?: number[];
  },
) {
  const {
    name, description, lat, lng, address, category_id, price, currency,
    place_time, end_time,
    duration_minutes, notes, image_url, google_place_id, osm_id, website, phone,
    transport_mode, tags = [],
  } = body;

  const result = db.prepare(`
    INSERT INTO places (trip_id, name, description, lat, lng, address, category_id, price, currency,
      place_time, end_time,
      duration_minutes, notes, image_url, google_place_id, osm_id, website, phone, transport_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tripId, name, description || null, lat || null, lng || null, address || null,
    category_id || null, price || null, currency || null,
    place_time || null, end_time || null, duration_minutes || 60, notes || null, image_url || null,
    google_place_id || null, osm_id || null, website || null, phone || null, transport_mode || 'walking',
  );

  const placeId = result.lastInsertRowid;

  if (tags && tags.length > 0) {
    const insertTag = db.prepare('INSERT OR IGNORE INTO place_tags (place_id, tag_id) VALUES (?, ?)');
    for (const tagId of tags) {
      insertTag.run(placeId, tagId);
    }
  }

  return getPlaceWithTags(Number(placeId));
}

// ---------------------------------------------------------------------------
// Get single place
// ---------------------------------------------------------------------------

export function getPlace(tripId: string, placeId: string) {
  const placeCheck = db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(placeId, tripId);
  if (!placeCheck) return null;
  return getPlaceWithTags(placeId);
}

// ---------------------------------------------------------------------------
// Update place
// ---------------------------------------------------------------------------

export function updatePlace(
  tripId: string,
  placeId: string,
  body: {
    name?: string; description?: string; lat?: number; lng?: number; address?: string;
    category_id?: number; price?: number; currency?: string;
    place_time?: string; end_time?: string;
    duration_minutes?: number; notes?: string; image_url?: string;
    google_place_id?: string; osm_id?: string; website?: string; phone?: string;
    transport_mode?: string; tags?: number[];
  },
) {
  const existingPlace = db.prepare('SELECT * FROM places WHERE id = ? AND trip_id = ?').get(placeId, tripId) as Place | undefined;
  if (!existingPlace) return null;

  const {
    name, description, lat, lng, address, category_id, price, currency,
    place_time, end_time,
    duration_minutes, notes, image_url, google_place_id, osm_id, website, phone,
    transport_mode, tags,
  } = body;

  db.prepare(`
    UPDATE places SET
      name = COALESCE(?, name),
      description = ?,
      lat = ?,
      lng = ?,
      address = ?,
      category_id = ?,
      price = ?,
      currency = COALESCE(?, currency),
      place_time = ?,
      end_time = ?,
      duration_minutes = COALESCE(?, duration_minutes),
      notes = ?,
      image_url = ?,
      google_place_id = ?,
      osm_id = ?,
      website = ?,
      phone = ?,
      transport_mode = COALESCE(?, transport_mode),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name || null,
    description !== undefined ? description : existingPlace.description,
    lat !== undefined ? lat : existingPlace.lat,
    lng !== undefined ? lng : existingPlace.lng,
    address !== undefined ? address : existingPlace.address,
    category_id !== undefined ? category_id : existingPlace.category_id,
    price !== undefined ? price : existingPlace.price,
    currency || null,
    place_time !== undefined ? place_time : existingPlace.place_time,
    end_time !== undefined ? end_time : existingPlace.end_time,
    duration_minutes || null,
    notes !== undefined ? notes : existingPlace.notes,
    image_url !== undefined ? image_url : existingPlace.image_url,
    google_place_id !== undefined ? google_place_id : existingPlace.google_place_id,
    osm_id !== undefined ? osm_id : existingPlace.osm_id,
    website !== undefined ? website : existingPlace.website,
    phone !== undefined ? phone : existingPlace.phone,
    transport_mode || null,
    placeId,
  );

  if (tags !== undefined) {
    db.prepare('DELETE FROM place_tags WHERE place_id = ?').run(placeId);
    if (tags.length > 0) {
      const insertTag = db.prepare('INSERT OR IGNORE INTO place_tags (place_id, tag_id) VALUES (?, ?)');
      for (const tagId of tags) {
        insertTag.run(placeId, tagId);
      }
    }
  }

  return getPlaceWithTags(placeId);
}

// ---------------------------------------------------------------------------
// Delete place
// ---------------------------------------------------------------------------

export function deletePlace(tripId: string, placeId: string): boolean {
  const place = db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(placeId, tripId);
  if (!place) return false;
  db.prepare('DELETE FROM places WHERE id = ?').run(placeId);
  return true;
}

// ---------------------------------------------------------------------------
// Import GPX
// ---------------------------------------------------------------------------

const gpxParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['wpt', 'trkpt', 'rtept', 'trk', 'trkseg', 'rte'].includes(name),
});

export function importGpx(tripId: string, fileBuffer: Buffer) {
  const parsed = gpxParser.parse(fileBuffer.toString('utf-8'));
  const gpx = parsed?.gpx;
  if (!gpx) return null;

  const str = (v: unknown) => (v != null ? String(v).trim() : null);
  const num = (v: unknown) => { const n = parseFloat(String(v)); return isNaN(n) ? null : n; };

  type WaypointEntry = { name: string; lat: number; lng: number; description: string | null; routeGeometry?: string };
  const waypoints: WaypointEntry[] = [];

  // 1) Parse <wpt> elements (named waypoints / POIs)
  for (const wpt of gpx.wpt ?? []) {
    const lat = num(wpt['@_lat']);
    const lng = num(wpt['@_lon']);
    if (lat === null || lng === null) continue;
    waypoints.push({ lat, lng, name: str(wpt.name) || `Waypoint ${waypoints.length + 1}`, description: str(wpt.desc) });
  }

  // 2) If no <wpt>, try <rte> route points as individual places
  if (waypoints.length === 0) {
    for (const rte of gpx.rte ?? []) {
      for (const rtept of rte.rtept ?? []) {
        const lat = num(rtept['@_lat']);
        const lng = num(rtept['@_lon']);
        if (lat === null || lng === null) continue;
        waypoints.push({ lat, lng, name: str(rtept.name) || `Route Point ${waypoints.length + 1}`, description: str(rtept.desc) });
      }
    }
  }

  // 3) Extract full track geometry from <trk> (always, even if <wpt> were found)
  for (const trk of gpx.trk ?? []) {
    const trackPoints: { lat: number; lng: number; ele: number | null }[] = [];
    for (const seg of trk.trkseg ?? []) {
      for (const pt of seg.trkpt ?? []) {
        const lat = num(pt['@_lat']);
        const lng = num(pt['@_lon']);
        if (lat === null || lng === null) continue;
        trackPoints.push({ lat, lng, ele: num(pt.ele) });
      }
    }
    if (trackPoints.length === 0) continue;
    const start = trackPoints[0];
    const hasAllEle = trackPoints.every(p => p.ele !== null);
    const routeGeometry = trackPoints.map(p => hasAllEle ? [p.lat, p.lng, p.ele] : [p.lat, p.lng]);
    waypoints.push({ lat: start.lat, lng: start.lng, name: str(trk.name) || 'GPX Track', description: str(trk.desc), routeGeometry: JSON.stringify(routeGeometry) });
  }

  if (waypoints.length === 0) return null;

  const insertStmt = db.prepare(`
    INSERT INTO places (trip_id, name, description, lat, lng, transport_mode, route_geometry)
    VALUES (?, ?, ?, ?, ?, 'walking', ?)
  `);
  const created: any[] = [];
  const insertAll = db.transaction(() => {
    for (const wp of waypoints) {
      const result = insertStmt.run(tripId, wp.name, wp.description, wp.lat, wp.lng, wp.routeGeometry || null);
      const place = getPlaceWithTags(Number(result.lastInsertRowid));
      created.push(place);
    }
  });
  insertAll();

  return created;
}

// ---------------------------------------------------------------------------
// Import Google Maps list
// ---------------------------------------------------------------------------

export async function importGoogleList(tripId: string, url: string) {
  let listId: string | null = null;
  let resolvedUrl = url;

  // Follow redirects for short URLs (maps.app.goo.gl, goo.gl)
  if (url.includes('goo.gl') || url.includes('maps.app')) {
    const redirectRes = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    resolvedUrl = redirectRes.url;
  }

  // Pattern: /placelists/list/{ID}
  const plMatch = resolvedUrl.match(/placelists\/list\/([A-Za-z0-9_-]+)/);
  if (plMatch) listId = plMatch[1];

  // Pattern: !2s{ID} in data URL params
  if (!listId) {
    const dataMatch = resolvedUrl.match(/!2s([A-Za-z0-9_-]{15,})/);
    if (dataMatch) listId = dataMatch[1];
  }

  if (!listId) {
    return { error: 'Could not extract list ID from URL. Please use a shared Google Maps list link.', status: 400 };
  }

  // Fetch list data from Google Maps internal API
  const apiUrl = `https://www.google.com/maps/preview/entitylist/getlist?authuser=0&hl=en&gl=us&pb=!1m1!1s${encodeURIComponent(listId)}!2e2!3e2!4i500!16b1`;
  const apiRes = await fetch(apiUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    signal: AbortSignal.timeout(15000),
  });

  if (!apiRes.ok) {
    return { error: 'Failed to fetch list from Google Maps', status: 502 };
  }

  const rawText = await apiRes.text();
  const jsonStr = rawText.substring(rawText.indexOf('\n') + 1);
  const listData = JSON.parse(jsonStr);

  const meta = listData[0];
  if (!meta) {
    return { error: 'Invalid list data received from Google Maps', status: 400 };
  }

  const listName = meta[4] || 'Google Maps List';
  const items = meta[8];

  if (!Array.isArray(items) || items.length === 0) {
    return { error: 'List is empty or could not be read', status: 400 };
  }

  // Parse place data from items
  const places: { name: string; lat: number; lng: number; notes: string | null }[] = [];
  for (const item of items) {
    const coords = item?.[1]?.[5];
    const lat = coords?.[2];
    const lng = coords?.[3];
    const name = item?.[2];
    const note = item?.[3] || null;

    if (name && typeof lat === 'number' && typeof lng === 'number' && !isNaN(lat) && !isNaN(lng)) {
      places.push({ name, lat, lng, notes: note || null });
    }
  }

  if (places.length === 0) {
    return { error: 'No places with coordinates found in list', status: 400 };
  }

  // Insert places into trip
  const insertStmt = db.prepare(`
    INSERT INTO places (trip_id, name, lat, lng, notes, transport_mode)
    VALUES (?, ?, ?, ?, ?, 'walking')
  `);
  const created: any[] = [];
  const insertAll = db.transaction(() => {
    for (const p of places) {
      const result = insertStmt.run(tripId, p.name, p.lat, p.lng, p.notes);
      const place = getPlaceWithTags(Number(result.lastInsertRowid));
      created.push(place);
    }
  });
  insertAll();

  return { places: created, listName };
}

// ---------------------------------------------------------------------------
// Search place image (Unsplash)
// ---------------------------------------------------------------------------

export async function searchPlaceImage(tripId: string, placeId: string, userId: number) {
  const place = db.prepare('SELECT * FROM places WHERE id = ? AND trip_id = ?').get(placeId, tripId) as Place | undefined;
  if (!place) return { error: 'Place not found', status: 404 };

  const user = db.prepare('SELECT unsplash_api_key FROM users WHERE id = ?').get(userId) as { unsplash_api_key: string | null } | undefined;
  if (!user || !user.unsplash_api_key) {
    return { error: 'No Unsplash API key configured', status: 400 };
  }

  const query = encodeURIComponent(place.name + (place.address ? ' ' + place.address : ''));
  const response = await fetch(
    `https://api.unsplash.com/search/photos?query=${query}&per_page=5&client_id=${user.unsplash_api_key}`,
  );
  const data = await response.json() as UnsplashSearchResponse;

  if (!response.ok) {
    return { error: data.errors?.[0] || 'Unsplash API error', status: response.status };
  }

  const photos = (data.results || []).map((p: NonNullable<UnsplashSearchResponse['results']>[number]) => ({
    id: p.id,
    url: p.urls?.regular,
    thumb: p.urls?.thumb,
    description: p.description || p.alt_description,
    photographer: p.user?.name,
    link: p.links?.html,
  }));

  return { photos };
}
