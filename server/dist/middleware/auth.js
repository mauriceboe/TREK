"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.demoUploadBlock = exports.adminOnly = exports.optionalAuth = exports.authenticate = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = require("../db/database");
const config_1 = require("../config");
const authenticate = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        res.status(401).json({ error: 'Access token required' });
        return;
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, config_1.JWT_SECRET);
        const user = database_1.db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(decoded.id);
        if (!user) {
            res.status(401).json({ error: 'User not found' });
            return;
        }
        req.user = user;
        next();
    }
    catch (err) {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
};
exports.authenticate = authenticate;
const optionalAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        req.user = null;
        return next();
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, config_1.JWT_SECRET);
        const user = database_1.db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(decoded.id);
        req.user = user || null;
    }
    catch (err) {
        req.user = null;
    }
    next();
};
exports.optionalAuth = optionalAuth;
const adminOnly = (req, res, next) => {
    const authReq = req;
    if (!authReq.user || authReq.user.role !== 'admin') {
        res.status(403).json({ error: 'Admin access required' });
        return;
    }
    next();
};
exports.adminOnly = adminOnly;
const demoUploadBlock = (req, res, next) => {
    const authReq = req;
    if (process.env.DEMO_MODE === 'true' && authReq.user?.email === 'demo@nomad.app') {
        res.status(403).json({ error: 'Uploads are disabled in demo mode. Self-host NOMAD for full functionality.' });
        return;
    }
    next();
};
exports.demoUploadBlock = demoUploadBlock;
//# sourceMappingURL=auth.js.map