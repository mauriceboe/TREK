"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadTagsByPlaceIds = loadTagsByPlaceIds;
exports.loadParticipantsByAssignmentIds = loadParticipantsByAssignmentIds;
exports.formatAssignmentWithPlace = formatAssignmentWithPlace;
const database_1 = require("../db/database");
/** Batch-load tags for multiple places in a single query, indexed by place ID. */
function loadTagsByPlaceIds(placeIds, { compact } = {}) {
    const tagsByPlaceId = {};
    if (placeIds.length > 0) {
        const placeholders = placeIds.map(() => '?').join(',');
        const allTags = database_1.db.prepare(`
      SELECT t.*, pt.place_id FROM tags t
      JOIN place_tags pt ON t.id = pt.tag_id
      WHERE pt.place_id IN (${placeholders})
    `).all(...placeIds);
        for (const tag of allTags) {
            const pid = tag.place_id;
            if (!tagsByPlaceId[pid])
                tagsByPlaceId[pid] = [];
            if (compact) {
                tagsByPlaceId[pid].push({ id: tag.id, name: tag.name, color: tag.color, created_at: tag.created_at });
            }
            else {
                const { place_id, ...rest } = tag;
                tagsByPlaceId[pid].push(rest);
            }
        }
    }
    return tagsByPlaceId;
}
/** Batch-load participants for multiple day-assignments in a single query, indexed by assignment ID. */
function loadParticipantsByAssignmentIds(assignmentIds) {
    const participantsByAssignment = {};
    if (assignmentIds.length > 0) {
        const allParticipants = database_1.db.prepare(`SELECT ap.assignment_id, ap.user_id, u.username, u.avatar FROM assignment_participants ap JOIN users u ON ap.user_id = u.id WHERE ap.assignment_id IN (${assignmentIds.map(() => '?').join(',')})`)
            .all(...assignmentIds);
        for (const p of allParticipants) {
            if (!participantsByAssignment[p.assignment_id])
                participantsByAssignment[p.assignment_id] = [];
            participantsByAssignment[p.assignment_id].push({ user_id: p.user_id, username: p.username, avatar: p.avatar });
        }
    }
    return participantsByAssignment;
}
/** Reshape a flat assignment+place DB row into the nested API response shape with embedded place, tags, and participants. */
function formatAssignmentWithPlace(a, tags, participants) {
    return {
        id: a.id,
        day_id: a.day_id,
        order_index: a.order_index,
        notes: a.notes,
        participants: participants || [],
        created_at: a.created_at,
        place: {
            id: a.place_id,
            name: a.place_name,
            description: a.place_description,
            lat: a.lat,
            lng: a.lng,
            address: a.address,
            category_id: a.category_id,
            price: a.price,
            currency: a.place_currency,
            place_time: a.place_time,
            end_time: a.end_time,
            duration_minutes: a.duration_minutes,
            notes: a.place_notes,
            image_url: a.image_url,
            transport_mode: a.transport_mode,
            google_place_id: a.google_place_id,
            website: a.website,
            phone: a.phone,
            category: a.category_id ? {
                id: a.category_id,
                name: a.category_name,
                color: a.category_color,
                icon: a.category_icon,
            } : null,
            tags: tags || [],
        }
    };
}
//# sourceMappingURL=queryHelpers.js.map