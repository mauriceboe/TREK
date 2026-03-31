"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetDemoUser = resetDemoUser;
exports.saveBaseline = saveBaseline;
exports.hasBaseline = hasBaseline;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const dataDir = path_1.default.join(__dirname, '../../data');
const dbPath = path_1.default.join(dataDir, 'travel.db');
const baselinePath = path_1.default.join(dataDir, 'travel-baseline.db');
function resetDemoUser() {
    if (!fs_1.default.existsSync(baselinePath)) {
        console.log('[Demo Reset] No baseline found, skipping. Admin must save baseline first.');
        return;
    }
    const { db, closeDb, reinitialize } = require('../db/database');
    // Save admin's current credentials and API keys (these should survive the reset)
    const adminEmail = process.env.DEMO_ADMIN_EMAIL || 'admin@nomad.app';
    let adminData = undefined;
    try {
        adminData = db.prepare('SELECT password_hash, maps_api_key, openweather_api_key, unsplash_api_key, avatar FROM users WHERE email = ?').get(adminEmail);
    }
    catch (e) {
        console.error('[Demo Reset] Failed to read admin data:', e instanceof Error ? e.message : e);
    }
    // Flush WAL to main DB file
    try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    catch (e) { }
    // Close DB connection
    closeDb();
    // Restore baseline
    try {
        fs_1.default.copyFileSync(baselinePath, dbPath);
        // Remove WAL/SHM files if they exist (stale from old connection)
        try {
            fs_1.default.unlinkSync(dbPath + '-wal');
        }
        catch (e) { }
        try {
            fs_1.default.unlinkSync(dbPath + '-shm');
        }
        catch (e) { }
    }
    catch (e) {
        console.error('[Demo Reset] Failed to restore baseline:', e instanceof Error ? e.message : e);
        reinitialize();
        return;
    }
    // Reinitialize DB connection with restored baseline
    reinitialize();
    // Restore admin's latest credentials (in case admin changed password/API keys after baseline was saved)
    if (adminData) {
        try {
            const { db: freshDb } = require('../db/database');
            freshDb.prepare('UPDATE users SET password_hash = ?, maps_api_key = ?, openweather_api_key = ?, unsplash_api_key = ?, avatar = ? WHERE email = ?').run(adminData.password_hash, adminData.maps_api_key, adminData.openweather_api_key, adminData.unsplash_api_key, adminData.avatar, adminEmail);
        }
        catch (e) {
            console.error('[Demo Reset] Failed to restore admin credentials:', e instanceof Error ? e.message : e);
        }
    }
    console.log('[Demo Reset] Database restored from baseline');
}
function saveBaseline() {
    const { db } = require('../db/database');
    // Flush WAL so baseline file is self-contained
    try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    catch (e) { }
    fs_1.default.copyFileSync(dbPath, baselinePath);
    console.log('[Demo] Baseline saved');
}
function hasBaseline() {
    return fs_1.default.existsSync(baselinePath);
}
//# sourceMappingURL=demo-reset.js.map