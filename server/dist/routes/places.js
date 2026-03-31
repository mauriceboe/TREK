"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const database_1 = require("../db/database");
const auth_1 = require("../middleware/auth");
const tripAccess_1 = require("../middleware/tripAccess");
const websocket_1 = require("../websocket");
const queryHelpers_1 = require("../services/queryHelpers");
const validate_1 = require("../middleware/validate");
const router = express_1.default.Router({ mergeParams: true });
router.get('/', auth_1.authenticate, tripAccess_1.requireTripAccess, (req, res) => {
    const { tripId } = req.params;
    const { search, category, tag } = req.query;
    let query = `
    SELECT DISTINCT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM places p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.trip_id = ?
  `;
    const params = [tripId];
    if (search) {
        query += ' AND (p.name LIKE ? OR p.address LIKE ? OR p.description LIKE ?)';
        const searchParam = `%${search}%`;
        params.push(searchParam, searchParam, searchParam);
    }
    if (category) {
        query += ' AND p.category_id = ?';
        params.push(category);
    }
    if (tag) {
        query += ' AND p.id IN (SELECT place_id FROM place_tags WHERE tag_id = ?)';
        params.push(tag);
    }
    query += ' ORDER BY p.created_at DESC';
    const places = database_1.db.prepare(query).all(...params);
    const placeIds = places.map(p => p.id);
    const tagsByPlaceId = (0, queryHelpers_1.loadTagsByPlaceIds)(placeIds);
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
router.post('/', auth_1.authenticate, tripAccess_1.requireTripAccess, (0, validate_1.validateStringLengths)({ name: 200, description: 2000, address: 500, notes: 2000 }), (req, res) => {
    const { tripId } = req.params;
    const { name, description, lat, lng, address, category_id, price, currency, place_time, end_time, duration_minutes, notes, image_url, google_place_id, osm_id, website, phone, transport_mode, tags = [] } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Place name is required' });
    }
    const result = database_1.db.prepare(`
    INSERT INTO places (trip_id, name, description, lat, lng, address, category_id, price, currency,
      place_time, end_time,
      duration_minutes, notes, image_url, google_place_id, osm_id, website, phone, transport_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tripId, name, description || null, lat || null, lng || null, address || null, category_id || null, price || null, currency || null, place_time || null, end_time || null, duration_minutes || 60, notes || null, image_url || null, google_place_id || null, osm_id || null, website || null, phone || null, transport_mode || 'walking');
    const placeId = result.lastInsertRowid;
    if (tags && tags.length > 0) {
        const insertTag = database_1.db.prepare('INSERT OR IGNORE INTO place_tags (place_id, tag_id) VALUES (?, ?)');
        for (const tagId of tags) {
            insertTag.run(placeId, tagId);
        }
    }
    const place = (0, database_1.getPlaceWithTags)(Number(placeId));
    res.status(201).json({ place });
    (0, websocket_1.broadcast)(tripId, 'place:created', { place }, req.headers['x-socket-id']);
});
router.get('/:id', auth_1.authenticate, tripAccess_1.requireTripAccess, (req, res) => {
    const { tripId, id } = req.params;
    const placeCheck = database_1.db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!placeCheck) {
        return res.status(404).json({ error: 'Place not found' });
    }
    const place = (0, database_1.getPlaceWithTags)(id);
    res.json({ place });
});
router.get('/:id/image', auth_1.authenticate, tripAccess_1.requireTripAccess, async (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const place = database_1.db.prepare('SELECT * FROM places WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!place) {
        return res.status(404).json({ error: 'Place not found' });
    }
    const user = database_1.db.prepare('SELECT unsplash_api_key FROM users WHERE id = ?').get(authReq.user.id);
    if (!user || !user.unsplash_api_key) {
        return res.status(400).json({ error: 'No Unsplash API key configured' });
    }
    try {
        const query = encodeURIComponent(place.name + (place.address ? ' ' + place.address : ''));
        const response = await (0, node_fetch_1.default)(`https://api.unsplash.com/search/photos?query=${query}&per_page=5&client_id=${user.unsplash_api_key}`);
        const data = await response.json();
        if (!response.ok) {
            return res.status(response.status).json({ error: data.errors?.[0] || 'Unsplash API error' });
        }
        const photos = (data.results || []).map((p) => ({
            id: p.id,
            url: p.urls?.regular,
            thumb: p.urls?.thumb,
            description: p.description || p.alt_description,
            photographer: p.user?.name,
            link: p.links?.html,
        }));
        res.json({ photos });
    }
    catch (err) {
        console.error('Unsplash error:', err);
        res.status(500).json({ error: 'Error searching for image' });
    }
});
router.put('/:id', auth_1.authenticate, tripAccess_1.requireTripAccess, (0, validate_1.validateStringLengths)({ name: 200, description: 2000, address: 500, notes: 2000 }), (req, res) => {
    const { tripId, id } = req.params;
    const existingPlace = database_1.db.prepare('SELECT * FROM places WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!existingPlace) {
        return res.status(404).json({ error: 'Place not found' });
    }
    const { name, description, lat, lng, address, category_id, price, currency, place_time, end_time, duration_minutes, notes, image_url, google_place_id, website, phone, transport_mode, tags } = req.body;
    database_1.db.prepare(`
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
  `).run(name || null, description !== undefined ? description : existingPlace.description, lat !== undefined ? lat : existingPlace.lat, lng !== undefined ? lng : existingPlace.lng, address !== undefined ? address : existingPlace.address, category_id !== undefined ? category_id : existingPlace.category_id, price !== undefined ? price : existingPlace.price, currency || null, place_time !== undefined ? place_time : existingPlace.place_time, end_time !== undefined ? end_time : existingPlace.end_time, duration_minutes || null, notes !== undefined ? notes : existingPlace.notes, image_url !== undefined ? image_url : existingPlace.image_url, google_place_id !== undefined ? google_place_id : existingPlace.google_place_id, website !== undefined ? website : existingPlace.website, phone !== undefined ? phone : existingPlace.phone, transport_mode || null, id);
    if (tags !== undefined) {
        database_1.db.prepare('DELETE FROM place_tags WHERE place_id = ?').run(id);
        if (tags.length > 0) {
            const insertTag = database_1.db.prepare('INSERT OR IGNORE INTO place_tags (place_id, tag_id) VALUES (?, ?)');
            for (const tagId of tags) {
                insertTag.run(id, tagId);
            }
        }
    }
    const place = (0, database_1.getPlaceWithTags)(id);
    res.json({ place });
    (0, websocket_1.broadcast)(tripId, 'place:updated', { place }, req.headers['x-socket-id']);
});
router.delete('/:id', auth_1.authenticate, tripAccess_1.requireTripAccess, (req, res) => {
    const { tripId, id } = req.params;
    const place = database_1.db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!place) {
        return res.status(404).json({ error: 'Place not found' });
    }
    database_1.db.prepare('DELETE FROM places WHERE id = ?').run(id);
    res.json({ success: true });
    (0, websocket_1.broadcast)(tripId, 'place:deleted', { placeId: Number(id) }, req.headers['x-socket-id']);
});
exports.default = router;
//# sourceMappingURL=places.js.map