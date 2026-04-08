import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { db, getPlaceWithTags } from '../db/database';
import { authenticate } from '../middleware/auth';
import { requireTripAccess } from '../middleware/tripAccess';
import { broadcast } from '../websocket';
import { loadTagsByPlaceIds } from '../services/queryHelpers';
import { validateStringLengths } from '../middleware/validate';
import { AuthRequest, Place } from '../types';

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

const gpxUpload = multer({ dest: path.join(__dirname, '../../uploads/tmp') });

router.post('/import/gpx', authenticate, requireTripAccess, gpxUpload.single('file'), (req: Request, res: Response) => {
  const { tripId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const xml = fs.readFileSync(req.file.path, 'utf8');
  fs.unlinkSync(req.file.path);
  const matches = [...xml.matchAll(/<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*>[\s\S]*?<name>([^<]+)<\/name>|<wpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*>[\s\S]*?<name>([^<]+)<\/name>/g)];
  const created: unknown[] = [];

  for (const match of matches) {
    const lat = Number(match[1] || match[4]);
    const lng = Number(match[2] || match[5]);
    const name = match[3] || match[6] || 'Imported waypoint';
    const result = db.prepare('INSERT INTO places (trip_id, name, lat, lng) VALUES (?, ?, ?, ?)').run(tripId, name, lat, lng);
    created.push(getPlaceWithTags(Number(result.lastInsertRowid)));
  }

  res.status(201).json({ places: created, count: created.length });
});

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
