"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
exports.closeDb = closeDb;
exports.reinitialize = reinitialize;
exports.getPlaceWithTags = getPlaceWithTags;
exports.canAccessTrip = canAccessTrip;
exports.isOwner = isOwner;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const schema_1 = require("./schema");
const migrations_1 = require("./migrations");
const seeds_1 = require("./seeds");
const dataDir = path_1.default.join(__dirname, '../../data');
if (!fs_1.default.existsSync(dataDir)) {
    fs_1.default.mkdirSync(dataDir, { recursive: true });
}
const dbPath = path_1.default.join(dataDir, 'travel.db');
let _db = null;
function initDb() {
    if (_db) {
        try {
            _db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        }
        catch (e) { }
        try {
            _db.close();
        }
        catch (e) { }
        _db = null;
    }
    _db = new better_sqlite3_1.default(dbPath);
    _db.exec('PRAGMA journal_mode = WAL');
    _db.exec('PRAGMA busy_timeout = 5000');
    _db.exec('PRAGMA foreign_keys = ON');
    (0, schema_1.createTables)(_db);
    (0, migrations_1.runMigrations)(_db);
    (0, seeds_1.runSeeds)(_db);
}
initDb();
if (process.env.DEMO_MODE === 'true') {
    try {
        const { seedDemoData } = require('../demo/demo-seed');
        seedDemoData(_db);
    }
    catch (err) {
        console.error('[Demo] Seed error:', err instanceof Error ? err.message : err);
    }
}
const db = new Proxy({}, {
    get(_, prop) {
        if (!_db)
            throw new Error('Database connection is not available (restore in progress?)');
        const val = _db[prop];
        return typeof val === 'function' ? val.bind(_db) : val;
    },
    set(_, prop, val) {
        _db[prop] = val;
        return true;
    },
});
exports.db = db;
function closeDb() {
    if (_db) {
        try {
            _db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        }
        catch (e) { }
        try {
            _db.close();
        }
        catch (e) { }
        _db = null;
        console.log('[DB] Database connection closed');
    }
}
function reinitialize() {
    console.log('[DB] Reinitializing database connection after restore...');
    if (_db)
        closeDb();
    initDb();
    console.log('[DB] Database reinitialized successfully');
}
function getPlaceWithTags(placeId) {
    const place = _db.prepare(`
    SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM places p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.id = ?
  `).get(placeId);
    if (!place)
        return null;
    const tags = _db.prepare(`
    SELECT t.* FROM tags t
    JOIN place_tags pt ON t.id = pt.tag_id
    WHERE pt.place_id = ?
  `).all(placeId);
    return {
        ...place,
        category: place.category_id ? {
            id: place.category_id,
            name: place.category_name,
            color: place.category_color,
            icon: place.category_icon,
        } : null,
        tags,
    };
}
function canAccessTrip(tripId, userId) {
    return _db.prepare(`
    SELECT t.id, t.user_id FROM trips t
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ?
    WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)
  `).get(userId, tripId, userId);
}
function isOwner(tripId, userId) {
    return !!_db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId);
}
//# sourceMappingURL=database.js.map