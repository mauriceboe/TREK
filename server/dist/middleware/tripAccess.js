"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireTripAccess = requireTripAccess;
exports.requireTripOwner = requireTripOwner;
const database_1 = require("../db/database");
/** Middleware: verifies the authenticated user is an owner or member of the trip, then attaches trip to req. */
function requireTripAccess(req, res, next) {
    const authReq = req;
    const tripId = req.params.tripId || req.params.id;
    if (!tripId) {
        res.status(400).json({ error: 'Trip ID required' });
        return;
    }
    const trip = (0, database_1.canAccessTrip)(Number(tripId), authReq.user.id);
    if (!trip) {
        res.status(404).json({ error: 'Trip not found' });
        return;
    }
    authReq.trip = trip;
    next();
}
/** Middleware: verifies the authenticated user is the trip owner (not just a member). */
function requireTripOwner(req, res, next) {
    const authReq = req;
    const tripId = req.params.tripId || req.params.id;
    if (!tripId) {
        res.status(400).json({ error: 'Trip ID required' });
        return;
    }
    if (!(0, database_1.isOwner)(Number(tripId), authReq.user.id)) {
        res.status(403).json({ error: 'Only the trip owner can do this' });
        return;
    }
    next();
}
//# sourceMappingURL=tripAccess.js.map