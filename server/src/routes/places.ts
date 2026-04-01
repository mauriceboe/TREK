import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import multer from 'multer';
import { db, getPlaceWithTags } from '../db/database';
import { authenticate } from '../middleware/auth';
import { requireTripAccess } from '../middleware/tripAccess';
import { broadcast } from '../websocket';
import { loadTagsByPlaceIds } from '../services/queryHelpers';
import { validateStringLengths } from '../middleware/validate';
import { checkPermission } from '../services/permissions';
import { AuthRequest, Place } from '../types';

const gpxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

interface PlaceWithCategory extends Place {
  category_name: string | null;
  category_color: string | null;
  category_icon: string | null;
}

interface UnsplashSearchResponse {
  results?: { id: string; urls?: { regular?: string; thumb?: string }; description?: string; alt_description?: string; user?: { name?: string }; links?: { html?: string } }[];
  errors?: string[];
}

const router = express.Router({ mergeParams: true });

router.get('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId } = req.params 
  const { search, category, tag } = req.query;

  let query = `
    SELECT DISTINCT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM places p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.trip_id = ?
  `;
  const params: (string | number)[] = [tripId];

  if (search) {
    query += ' AND (p.name LIKE ? OR p.address LIKE ? OR p.description LIKE ?)';
    const searchParam = `%${search}%`;
    params.push(searchParam, searchParam, searchParam);
  }

  if (category) {
    query += ' AND p.category_id = ?';
    params.push(category as string);
  }

  if (tag) {
    query += ' AND p.id IN (SELECT place_id FROM place_tags WHERE tag_id = ?)';
    params.push(tag as string);
  }

  query += ' ORDER BY p.created_at DESC';

  const places = db.prepare(query).all(...params) as PlaceWithCategory[];

  const placeIds = places.map(p => p.id);
  const tagsByPlaceId = loadTagsByPlaceIds(placeIds);

  const placesWithTags = places.map(p => {
    return {
      ...p,
      category: p.category_id ? {
        id: p.category_id,
        name: p.category_name,
        color: p.category_color,
        icon: p.category_icon,
      } : null,
      tags: tagsByPlaceId[p.id] || [],
    };
  });

  res.json({ places: placesWithTags });
});

router.post('/', authenticate, requireTripAccess, validateStringLengths({ name: 200, description: 2000, address: 500, notes: 2000 }), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('place_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId } = req.params

  const {
    name, description, lat, lng, address, category_id, price, currency,
    place_time, end_time,
    duration_minutes, notes, image_url, google_place_id, osm_id, website, phone,
    transport_mode, tags = []
  } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Place name is required' });
  }

  const result = db.prepare(`
    INSERT INTO places (trip_id, name, description, lat, lng, address, category_id, price, currency,
      place_time, end_time,
      duration_minutes, notes, image_url, google_place_id, osm_id, website, phone, transport_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tripId, name, description || null, lat || null, lng || null, address || null,
    category_id || null, price || null, currency || null,
    place_time || null, end_time || null, duration_minutes || 60, notes || null, image_url || null,
    google_place_id || null, osm_id || null, website || null, phone || null, transport_mode || 'walking'
  );

  const placeId = result.lastInsertRowid;

  if (tags && tags.length > 0) {
    const insertTag = db.prepare('INSERT OR IGNORE INTO place_tags (place_id, tag_id) VALUES (?, ?)');
    for (const tagId of tags) {
      insertTag.run(placeId, tagId);
    }
  }

  const place = getPlaceWithTags(Number(placeId));
  res.status(201).json({ place });
  broadcast(tripId, 'place:created', { place }, req.headers['x-socket-id'] as string);
});

// Import places from GPX file with full track geometry (must be before /:id)
router.post('/import/gpx', authenticate, requireTripAccess, gpxUpload.single('file'), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('place_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId } = req.params;
  const file = (req as any).file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  const xml = file.buffer.toString('utf-8');

  const parseCoords = (attrs: string): { lat: number; lng: number } | null => {
    const latMatch = attrs.match(/lat=["']([^"']+)["']/i);
    const lonMatch = attrs.match(/lon=["']([^"']+)["']/i);
    if (!latMatch || !lonMatch) return null;
    const lat = parseFloat(latMatch[1]);
    const lng = parseFloat(lonMatch[1]);
    return (!isNaN(lat) && !isNaN(lng)) ? { lat, lng } : null;
  };

  const stripCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  const extractName = (body: string) => { const m = body.match(/<name[^>]*>([\s\S]*?)<\/name>/i); return m ? stripCdata(m[1]) : null };
  const extractDesc = (body: string) => { const m = body.match(/<desc[^>]*>([\s\S]*?)<\/desc>/i); return m ? stripCdata(m[1]) : null };

  const waypoints: { name: string; lat: number; lng: number; description: string | null; routeGeometry?: string }[] = [];

  // 1) Parse <wpt> elements (named waypoints / POIs)
  const wptRegex = /<wpt\s([^>]+)>([\s\S]*?)<\/wpt>/gi;
  let match;
  while ((match = wptRegex.exec(xml)) !== null) {
    const coords = parseCoords(match[1]);
    if (!coords) continue;
    const name = extractName(match[2]) || `Waypoint ${waypoints.length + 1}`;
    waypoints.push({ ...coords, name, description: extractDesc(match[2]) });
  }

  // 2) If no <wpt>, try <rtept> (route points)
  if (waypoints.length === 0) {
    const rteptRegex = /<rtept\s([^>]+)>([\s\S]*?)<\/rtept>/gi;
    while ((match = rteptRegex.exec(xml)) !== null) {
      const coords = parseCoords(match[1]);
      if (!coords) continue;
      const name = extractName(match[2]) || `Route Point ${waypoints.length + 1}`;
      waypoints.push({ ...coords, name, description: extractDesc(match[2]) });
    }
  }

  // 3) If still nothing, extract full track geometry from <trkpt>
  if (waypoints.length === 0) {
    const trackNameMatch = xml.match(/<trk[^>]*>[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>/i);
    const trackName = trackNameMatch?.[1]?.trim() || 'GPX Track';
    const trackDesc = (() => { const m = xml.match(/<trk[^>]*>[\s\S]*?<desc[^>]*>([\s\S]*?)<\/desc>/i); return m ? stripCdata(m[1]) : null })();
    const trkptRegex = /<trkpt\s([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/gi;
    const trackPoints: { lat: number; lng: number; ele: number | null }[] = [];
    while ((match = trkptRegex.exec(xml)) !== null) {
      const coords = parseCoords(match[1]);
      if (!coords) continue;
      const eleMatch = match[2]?.match(/<ele[^>]*>([\s\S]*?)<\/ele>/i);
      const ele = eleMatch ? parseFloat(eleMatch[1]) : null;
      trackPoints.push({ ...coords, ele: (ele !== null && !isNaN(ele)) ? ele : null });
    }
    if (trackPoints.length > 0) {
      const start = trackPoints[0];
      const hasAllEle = trackPoints.every(p => p.ele !== null);
      const routeGeometry = trackPoints.map(p => hasAllEle ? [p.lat, p.lng, p.ele] : [p.lat, p.lng]);
      waypoints.push({ ...start, name: trackName, description: trackDesc, routeGeometry: JSON.stringify(routeGeometry) });
    }
  }

  if (waypoints.length === 0) {
    return res.status(400).json({ error: 'No waypoints found in GPX file' });
  }

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

  res.status(201).json({ places: created, count: created.length });
  for (const place of created) {
    broadcast(tripId, 'place:created', { place }, req.headers['x-socket-id'] as string);
  }
});

// Import places from a shared Google Maps list URL
router.post('/import/google-list', authenticate, requireTripAccess, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('place_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId } = req.params;
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL is required' });

  try {
    // Extract list ID from various Google Maps list URL formats
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
      return res.status(400).json({ error: 'Could not extract list ID from URL. Please use a shared Google Maps list link.' });
    }

    // Fetch list data from Google Maps internal API
    const apiUrl = `https://www.google.com/maps/preview/entitylist/getlist?authuser=0&hl=en&gl=us&pb=!1m1!1s${encodeURIComponent(listId)}!2e2!3e2!4i500!16b1`;
    const apiRes = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(15000),
    });

    if (!apiRes.ok) {
      return res.status(502).json({ error: 'Failed to fetch list from Google Maps' });
    }

    const rawText = await apiRes.text();
    const jsonStr = rawText.substring(rawText.indexOf('\n') + 1);
    const listData = JSON.parse(jsonStr);

    const meta = listData[0];
    if (!meta) {
      return res.status(400).json({ error: 'Invalid list data received from Google Maps' });
    }

    const listName = meta[4] || 'Google Maps List';
    const items = meta[8];

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'List is empty or could not be read' });
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
      return res.status(400).json({ error: 'No places with coordinates found in list' });
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

    res.status(201).json({ places: created, count: created.length, listName });
    for (const place of created) {
      broadcast(tripId, 'place:created', { place }, req.headers['x-socket-id'] as string);
    }
  } catch (err: unknown) {
    console.error('[Places] Google list import error:', err instanceof Error ? err.message : err);
    res.status(400).json({ error: 'Failed to import Google Maps list. Make sure the list is shared publicly.' });
  }
});

router.get('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, id } = req.params 

  const placeCheck = db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!placeCheck) {
    return res.status(404).json({ error: 'Place not found' });
  }

  const place = getPlaceWithTags(id);
  res.json({ place });
});

router.get('/:id/image', authenticate, requireTripAccess, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params 

  const place = db.prepare('SELECT * FROM places WHERE id = ? AND trip_id = ?').get(id, tripId) as Place | undefined;
  if (!place) {
    return res.status(404).json({ error: 'Place not found' });
  }

  const user = db.prepare('SELECT unsplash_api_key FROM users WHERE id = ?').get(authReq.user.id) as { unsplash_api_key: string | null } | undefined;
  if (!user || !user.unsplash_api_key) {
    return res.status(400).json({ error: 'No Unsplash API key configured' });
  }

  try {
    const query = encodeURIComponent(place.name + (place.address ? ' ' + place.address : ''));
    const response = await fetch(
      `https://api.unsplash.com/search/photos?query=${query}&per_page=5&client_id=${user.unsplash_api_key}`
    );
    const data = await response.json() as UnsplashSearchResponse;

    if (!response.ok) {
      return res.status(response.status).json({ error: data.errors?.[0] || 'Unsplash API error' });
    }

    const photos = (data.results || []).map((p: NonNullable<UnsplashSearchResponse['results']>[number]) => ({
      id: p.id,
      url: p.urls?.regular,
      thumb: p.urls?.thumb,
      description: p.description || p.alt_description,
      photographer: p.user?.name,
      link: p.links?.html,
    }));

    res.json({ photos });
  } catch (err: unknown) {
    console.error('Unsplash error:', err);
    res.status(500).json({ error: 'Error searching for image' });
  }
});

router.put('/:id', authenticate, requireTripAccess, validateStringLengths({ name: 200, description: 2000, address: 500, notes: 2000 }), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('place_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params

  const existingPlace = db.prepare('SELECT * FROM places WHERE id = ? AND trip_id = ?').get(id, tripId) as Place | undefined;
  if (!existingPlace) {
    return res.status(404).json({ error: 'Place not found' });
  }

  const {
    name, description, lat, lng, address, category_id, price, currency,
    place_time, end_time,
    duration_minutes, notes, image_url, google_place_id, website, phone,
    transport_mode, tags
  } = req.body;

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
    website !== undefined ? website : existingPlace.website,
    phone !== undefined ? phone : existingPlace.phone,
    transport_mode || null,
    id
  );

  if (tags !== undefined) {
    db.prepare('DELETE FROM place_tags WHERE place_id = ?').run(id);
    if (tags.length > 0) {
      const insertTag = db.prepare('INSERT OR IGNORE INTO place_tags (place_id, tag_id) VALUES (?, ?)');
      for (const tagId of tags) {
        insertTag.run(id, tagId);
      }
    }
  }

  const place = getPlaceWithTags(id);
  res.json({ place });
  broadcast(tripId, 'place:updated', { place }, req.headers['x-socket-id'] as string);
});

router.delete('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('place_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params

  const place = db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!place) {
    return res.status(404).json({ error: 'Place not found' });
  }

  db.prepare('DELETE FROM places WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'place:deleted', { placeId: Number(id) }, req.headers['x-socket-id'] as string);
});

export default router;
