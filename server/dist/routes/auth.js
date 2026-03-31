"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const uuid_1 = require("uuid");
const node_fetch_1 = __importDefault(require("node-fetch"));
const otplib_1 = require("otplib");
const qrcode_1 = __importDefault(require("qrcode"));
const database_1 = require("../db/database");
const auth_1 = require("../middleware/auth");
const config_1 = require("../config");
const mfaCrypto_1 = require("../services/mfaCrypto");
otplib_1.authenticator.options = { window: 1 };
const MFA_SETUP_TTL_MS = 15 * 60 * 1000;
const mfaSetupPending = new Map();
function getPendingMfaSecret(userId) {
    const row = mfaSetupPending.get(userId);
    if (!row || Date.now() > row.exp) {
        mfaSetupPending.delete(userId);
        return null;
    }
    return row.secret;
}
function stripUserForClient(user) {
    const { password_hash: _p, maps_api_key: _m, openweather_api_key: _o, unsplash_api_key: _u, mfa_secret: _mf, ...rest } = user;
    return {
        ...rest,
        mfa_enabled: !!(user.mfa_enabled === 1 || user.mfa_enabled === true),
    };
}
const router = express_1.default.Router();
const avatarDir = path_1.default.join(__dirname, '../../data/uploads/avatars');
if (!fs_1.default.existsSync(avatarDir))
    fs_1.default.mkdirSync(avatarDir, { recursive: true });
const avatarStorage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, avatarDir),
    filename: (_req, file, cb) => cb(null, (0, uuid_1.v4)() + path_1.default.extname(file.originalname))
});
const ALLOWED_AVATAR_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5 MB
const avatarUpload = (0, multer_1.default)({ storage: avatarStorage, limits: { fileSize: MAX_AVATAR_SIZE }, fileFilter: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname).toLowerCase();
        if (!file.mimetype.startsWith('image/') || !ALLOWED_AVATAR_EXTS.includes(ext)) {
            return cb(new Error('Only .jpg, .jpeg, .png, .gif, .webp images are allowed'));
        }
        cb(null, true);
    } });
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_CLEANUP = 5 * 60 * 1000; // 5 minutes
const loginAttempts = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [key, record] of loginAttempts) {
        if (now - record.first >= RATE_LIMIT_WINDOW)
            loginAttempts.delete(key);
    }
}, RATE_LIMIT_CLEANUP);
function rateLimiter(maxAttempts, windowMs) {
    return (req, res, next) => {
        const key = req.ip || 'unknown';
        const now = Date.now();
        const record = loginAttempts.get(key);
        if (record && record.count >= maxAttempts && now - record.first < windowMs) {
            return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
        }
        if (!record || now - record.first >= windowMs) {
            loginAttempts.set(key, { count: 1, first: now });
        }
        else {
            record.count++;
        }
        next();
    };
}
const authLimiter = rateLimiter(10, RATE_LIMIT_WINDOW);
function isOidcOnlyMode() {
    const get = (key) => database_1.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)?.value || null;
    const enabled = process.env.OIDC_ONLY === 'true' || get('oidc_only') === 'true';
    if (!enabled)
        return false;
    const oidcConfigured = !!((process.env.OIDC_ISSUER || get('oidc_issuer')) &&
        (process.env.OIDC_CLIENT_ID || get('oidc_client_id')));
    return oidcConfigured;
}
function maskKey(key) {
    if (!key)
        return null;
    if (key.length <= 8)
        return '--------';
    return '----' + key.slice(-4);
}
function avatarUrl(user) {
    return user.avatar ? `/uploads/avatars/${user.avatar}` : null;
}
function generateToken(user) {
    return jsonwebtoken_1.default.sign({ id: user.id }, config_1.JWT_SECRET, { expiresIn: '24h' });
}
router.get('/app-config', (_req, res) => {
    const userCount = database_1.db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const setting = database_1.db.prepare("SELECT value FROM app_settings WHERE key = 'allow_registration'").get();
    const allowRegistration = userCount === 0 || (setting?.value ?? 'true') === 'true';
    const isDemo = process.env.DEMO_MODE === 'true';
    const { version } = require('../../package.json');
    const hasGoogleKey = !!database_1.db.prepare("SELECT maps_api_key FROM users WHERE role = 'admin' AND maps_api_key IS NOT NULL AND maps_api_key != '' LIMIT 1").get();
    const oidcDisplayName = process.env.OIDC_DISPLAY_NAME || database_1.db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_display_name'").get()?.value || null;
    const oidcConfigured = !!((process.env.OIDC_ISSUER || database_1.db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_issuer'").get()?.value) &&
        (process.env.OIDC_CLIENT_ID || database_1.db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_client_id'").get()?.value));
    const oidcOnlySetting = process.env.OIDC_ONLY || database_1.db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_only'").get()?.value;
    const oidcOnlyMode = oidcConfigured && oidcOnlySetting === 'true';
    res.json({
        allow_registration: isDemo ? false : allowRegistration,
        has_users: userCount > 0,
        version,
        has_maps_key: hasGoogleKey,
        oidc_configured: oidcConfigured,
        oidc_display_name: oidcConfigured ? (oidcDisplayName || 'SSO') : undefined,
        oidc_only_mode: oidcOnlyMode,
        allowed_file_types: database_1.db.prepare("SELECT value FROM app_settings WHERE key = 'allowed_file_types'").get()?.value || 'jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv',
        demo_mode: isDemo,
        demo_email: isDemo ? 'demo@trek.app' : undefined,
        demo_password: isDemo ? 'demo12345' : undefined,
    });
});
router.post('/demo-login', (_req, res) => {
    if (process.env.DEMO_MODE !== 'true') {
        return res.status(404).json({ error: 'Not found' });
    }
    const user = database_1.db.prepare('SELECT * FROM users WHERE email = ?').get('demo@trek.app');
    if (!user)
        return res.status(500).json({ error: 'Demo user not found' });
    const token = generateToken(user);
    const safe = stripUserForClient(user);
    res.json({ token, user: { ...safe, avatar_url: avatarUrl(user) } });
});
// Validate invite token (public, no auth needed, rate limited)
router.get('/invite/:token', authLimiter, (req, res) => {
    const invite = database_1.db.prepare('SELECT * FROM invite_tokens WHERE token = ?').get(req.params.token);
    if (!invite)
        return res.status(404).json({ error: 'Invalid invite link' });
    if (invite.max_uses > 0 && invite.used_count >= invite.max_uses)
        return res.status(410).json({ error: 'Invite link has been fully used' });
    if (invite.expires_at && new Date(invite.expires_at) < new Date())
        return res.status(410).json({ error: 'Invite link has expired' });
    res.json({ valid: true, max_uses: invite.max_uses, used_count: invite.used_count, expires_at: invite.expires_at });
});
router.post('/register', authLimiter, (req, res) => {
    const { username, email, password, invite_token } = req.body;
    const userCount = database_1.db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    // Check invite token first — valid token bypasses registration restrictions
    let validInvite = null;
    if (invite_token) {
        validInvite = database_1.db.prepare('SELECT * FROM invite_tokens WHERE token = ?').get(invite_token);
        if (!validInvite)
            return res.status(400).json({ error: 'Invalid invite link' });
        if (validInvite.max_uses > 0 && validInvite.used_count >= validInvite.max_uses)
            return res.status(410).json({ error: 'Invite link has been fully used' });
        if (validInvite.expires_at && new Date(validInvite.expires_at) < new Date())
            return res.status(410).json({ error: 'Invite link has expired' });
    }
    if (userCount > 0 && !validInvite) {
        if (isOidcOnlyMode()) {
            return res.status(403).json({ error: 'Password authentication is disabled. Please sign in with SSO.' });
        }
        const setting = database_1.db.prepare("SELECT value FROM app_settings WHERE key = 'allow_registration'").get();
        if (setting?.value === 'false') {
            return res.status(403).json({ error: 'Registration is disabled. Contact your administrator.' });
        }
    }
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Username, email and password are required' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
        return res.status(400).json({ error: 'Password must contain at least one uppercase letter, one lowercase letter, and one number' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }
    const existingUser = database_1.db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)').get(email, username);
    if (existingUser) {
        return res.status(409).json({ error: 'Registration failed. Please try different credentials.' });
    }
    const password_hash = bcryptjs_1.default.hashSync(password, 12);
    const isFirstUser = userCount === 0;
    const role = isFirstUser ? 'admin' : 'user';
    try {
        const result = database_1.db.prepare('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)').run(username, email, password_hash, role);
        const user = { id: result.lastInsertRowid, username, email, role, avatar: null, mfa_enabled: false };
        const token = generateToken(user);
        // Atomically increment invite token usage (prevents race condition)
        if (validInvite) {
            const updated = database_1.db.prepare('UPDATE invite_tokens SET used_count = used_count + 1 WHERE id = ? AND (max_uses = 0 OR used_count < max_uses) RETURNING used_count').get(validInvite.id);
            if (!updated) {
                // Race condition: token was used up between check and now — user was already created, so just log it
                console.warn(`[Auth] Invite token ${validInvite.token.slice(0, 8)}... exceeded max_uses due to race condition`);
            }
        }
        res.status(201).json({ token, user: { ...user, avatar_url: null } });
    }
    catch (err) {
        res.status(500).json({ error: 'Error creating user' });
    }
});
router.post('/login', authLimiter, (req, res) => {
    if (isOidcOnlyMode()) {
        return res.status(403).json({ error: 'Password authentication is disabled. Please sign in with SSO.' });
    }
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = database_1.db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email);
    if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
    }
    const validPassword = bcryptjs_1.default.compareSync(password, user.password_hash);
    if (!validPassword) {
        return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.mfa_enabled === 1 || user.mfa_enabled === true) {
        const mfa_token = jsonwebtoken_1.default.sign({ id: Number(user.id), purpose: 'mfa_login' }, config_1.JWT_SECRET, { expiresIn: '5m' });
        return res.json({ mfa_required: true, mfa_token });
    }
    database_1.db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    const token = generateToken(user);
    const userSafe = stripUserForClient(user);
    res.json({ token, user: { ...userSafe, avatar_url: avatarUrl(user) } });
});
router.get('/me', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const user = database_1.db.prepare('SELECT id, username, email, role, avatar, oidc_issuer, created_at, mfa_enabled FROM users WHERE id = ?').get(authReq.user.id);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    const base = stripUserForClient(user);
    res.json({ user: { ...base, avatar_url: avatarUrl(user) } });
});
router.put('/me/password', auth_1.authenticate, rateLimiter(5, RATE_LIMIT_WINDOW), (req, res) => {
    const authReq = req;
    if (isOidcOnlyMode()) {
        return res.status(403).json({ error: 'Password authentication is disabled.' });
    }
    if (process.env.DEMO_MODE === 'true' && authReq.user.email === 'demo@trek.app') {
        return res.status(403).json({ error: 'Password change is disabled in demo mode.' });
    }
    const { current_password, new_password } = req.body;
    if (!current_password)
        return res.status(400).json({ error: 'Current password is required' });
    if (!new_password)
        return res.status(400).json({ error: 'New password is required' });
    if (new_password.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!/[A-Z]/.test(new_password) || !/[a-z]/.test(new_password) || !/[0-9]/.test(new_password)) {
        return res.status(400).json({ error: 'Password must contain at least one uppercase letter, one lowercase letter, and one number' });
    }
    const user = database_1.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(authReq.user.id);
    if (!user || !bcryptjs_1.default.compareSync(current_password, user.password_hash)) {
        return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = bcryptjs_1.default.hashSync(new_password, 12);
    database_1.db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, authReq.user.id);
    res.json({ success: true });
});
router.delete('/me', auth_1.authenticate, (req, res) => {
    const authReq = req;
    if (process.env.DEMO_MODE === 'true' && authReq.user.email === 'demo@trek.app') {
        return res.status(403).json({ error: 'Account deletion is disabled in demo mode.' });
    }
    if (authReq.user.role === 'admin') {
        const adminCount = database_1.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
        if (adminCount <= 1) {
            return res.status(400).json({ error: 'Cannot delete the last admin account' });
        }
    }
    database_1.db.prepare('DELETE FROM users WHERE id = ?').run(authReq.user.id);
    res.json({ success: true });
});
router.put('/me/maps-key', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { maps_api_key } = req.body;
    database_1.db.prepare('UPDATE users SET maps_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(maps_api_key || null, authReq.user.id);
    res.json({ success: true, maps_api_key: maps_api_key || null });
});
router.put('/me/api-keys', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { maps_api_key, openweather_api_key } = req.body;
    const current = database_1.db.prepare('SELECT maps_api_key, openweather_api_key FROM users WHERE id = ?').get(authReq.user.id);
    database_1.db.prepare('UPDATE users SET maps_api_key = ?, openweather_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(maps_api_key !== undefined ? (maps_api_key || null) : current.maps_api_key, openweather_api_key !== undefined ? (openweather_api_key || null) : current.openweather_api_key, authReq.user.id);
    const updated = database_1.db.prepare('SELECT id, username, email, role, maps_api_key, openweather_api_key, avatar, mfa_enabled FROM users WHERE id = ?').get(authReq.user.id);
    const u = updated ? { ...updated, mfa_enabled: !!(updated.mfa_enabled === 1 || updated.mfa_enabled === true) } : undefined;
    res.json({ success: true, user: { ...u, maps_api_key: maskKey(u?.maps_api_key), openweather_api_key: maskKey(u?.openweather_api_key), avatar_url: avatarUrl(updated || {}) } });
});
router.put('/me/settings', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { maps_api_key, openweather_api_key, username, email } = req.body;
    if (username !== undefined) {
        const trimmed = username.trim();
        if (!trimmed || trimmed.length < 2 || trimmed.length > 50) {
            return res.status(400).json({ error: 'Username must be between 2 and 50 characters' });
        }
        if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
            return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores, dots and hyphens' });
        }
        const conflict = database_1.db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?').get(trimmed, authReq.user.id);
        if (conflict)
            return res.status(409).json({ error: 'Username already taken' });
    }
    if (email !== undefined) {
        const trimmed = email.trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!trimmed || !emailRegex.test(trimmed)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        const conflict = database_1.db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?').get(trimmed, authReq.user.id);
        if (conflict)
            return res.status(409).json({ error: 'Email already taken' });
    }
    const updates = [];
    const params = [];
    if (maps_api_key !== undefined) {
        updates.push('maps_api_key = ?');
        params.push(maps_api_key || null);
    }
    if (openweather_api_key !== undefined) {
        updates.push('openweather_api_key = ?');
        params.push(openweather_api_key || null);
    }
    if (username !== undefined) {
        updates.push('username = ?');
        params.push(username.trim());
    }
    if (email !== undefined) {
        updates.push('email = ?');
        params.push(email.trim());
    }
    if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(authReq.user.id);
        database_1.db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
    const updated = database_1.db.prepare('SELECT id, username, email, role, maps_api_key, openweather_api_key, avatar, mfa_enabled FROM users WHERE id = ?').get(authReq.user.id);
    const u = updated ? { ...updated, mfa_enabled: !!(updated.mfa_enabled === 1 || updated.mfa_enabled === true) } : undefined;
    res.json({ success: true, user: { ...u, maps_api_key: maskKey(u?.maps_api_key), openweather_api_key: maskKey(u?.openweather_api_key), avatar_url: avatarUrl(updated || {}) } });
});
router.get('/me/settings', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const user = database_1.db.prepare('SELECT role, maps_api_key, openweather_api_key FROM users WHERE id = ?').get(authReq.user.id);
    if (user?.role !== 'admin')
        return res.status(403).json({ error: 'Admin access required' });
    res.json({ settings: { maps_api_key: user.maps_api_key, openweather_api_key: user.openweather_api_key } });
});
router.post('/avatar', auth_1.authenticate, auth_1.demoUploadBlock, avatarUpload.single('avatar'), (req, res) => {
    const authReq = req;
    if (!req.file)
        return res.status(400).json({ error: 'No image uploaded' });
    const current = database_1.db.prepare('SELECT avatar FROM users WHERE id = ?').get(authReq.user.id);
    if (current && current.avatar) {
        const oldPath = path_1.default.join(avatarDir, current.avatar);
        if (fs_1.default.existsSync(oldPath))
            fs_1.default.unlinkSync(oldPath);
    }
    const filename = req.file.filename;
    database_1.db.prepare('UPDATE users SET avatar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(filename, authReq.user.id);
    const updated = database_1.db.prepare('SELECT id, username, email, role, avatar FROM users WHERE id = ?').get(authReq.user.id);
    res.json({ success: true, avatar_url: avatarUrl(updated || {}) });
});
router.delete('/avatar', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const current = database_1.db.prepare('SELECT avatar FROM users WHERE id = ?').get(authReq.user.id);
    if (current && current.avatar) {
        const filePath = path_1.default.join(avatarDir, current.avatar);
        if (fs_1.default.existsSync(filePath))
            fs_1.default.unlinkSync(filePath);
    }
    database_1.db.prepare('UPDATE users SET avatar = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(authReq.user.id);
    res.json({ success: true });
});
router.get('/users', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const users = database_1.db.prepare('SELECT id, username, avatar FROM users WHERE id != ? ORDER BY username ASC').all(authReq.user.id);
    res.json({ users: users.map(u => ({ ...u, avatar_url: avatarUrl(u) })) });
});
router.get('/validate-keys', auth_1.authenticate, async (req, res) => {
    const authReq = req;
    const user = database_1.db.prepare('SELECT role, maps_api_key, openweather_api_key FROM users WHERE id = ?').get(authReq.user.id);
    if (user?.role !== 'admin')
        return res.status(403).json({ error: 'Admin access required' });
    const result = { maps: false, weather: false };
    if (user.maps_api_key) {
        try {
            const mapsRes = await (0, node_fetch_1.default)(`https://places.googleapis.com/v1/places:searchText`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': user.maps_api_key,
                    'X-Goog-FieldMask': 'places.displayName',
                },
                body: JSON.stringify({ textQuery: 'test' }),
            });
            result.maps = mapsRes.status === 200;
        }
        catch (err) {
            result.maps = false;
        }
    }
    if (user.openweather_api_key) {
        try {
            const weatherRes = await (0, node_fetch_1.default)(`https://api.openweathermap.org/data/2.5/weather?q=London&appid=${user.openweather_api_key}`);
            result.weather = weatherRes.status === 200;
        }
        catch (err) {
            result.weather = false;
        }
    }
    res.json(result);
});
router.put('/app-settings', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const user = database_1.db.prepare('SELECT role FROM users WHERE id = ?').get(authReq.user.id);
    if (user?.role !== 'admin')
        return res.status(403).json({ error: 'Admin access required' });
    const { allow_registration, allowed_file_types } = req.body;
    if (allow_registration !== undefined) {
        database_1.db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('allow_registration', ?)").run(String(allow_registration));
    }
    if (allowed_file_types !== undefined) {
        database_1.db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('allowed_file_types', ?)").run(String(allowed_file_types));
    }
    res.json({ success: true });
});
router.get('/travel-stats', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const userId = authReq.user.id;
    const places = database_1.db.prepare(`
    SELECT DISTINCT p.address, p.lat, p.lng
    FROM places p
    JOIN trips t ON p.trip_id = t.id
    LEFT JOIN trip_members tm ON t.id = tm.trip_id
    WHERE t.user_id = ? OR tm.user_id = ?
  `).all(userId, userId);
    const tripStats = database_1.db.prepare(`
    SELECT COUNT(DISTINCT t.id) as trips,
           COUNT(DISTINCT d.id) as days
    FROM trips t
    LEFT JOIN days d ON d.trip_id = t.id
    LEFT JOIN trip_members tm ON t.id = tm.trip_id
    WHERE (t.user_id = ? OR tm.user_id = ?) AND t.is_archived = 0
  `).get(userId, userId);
    const KNOWN_COUNTRIES = new Set([
        'Japan', 'Germany', 'Deutschland', 'France', 'Frankreich', 'Italy', 'Italien', 'Spain', 'Spanien',
        'United States', 'USA', 'United Kingdom', 'UK', 'Thailand', 'Australia', 'Australien',
        'Canada', 'Kanada', 'Mexico', 'Mexiko', 'Brazil', 'Brasilien', 'China', 'India', 'Indien',
        'South Korea', 'Sudkorea', 'Indonesia', 'Indonesien', 'Turkey', 'Turkei', 'Turkiye',
        'Greece', 'Griechenland', 'Portugal', 'Netherlands', 'Niederlande', 'Belgium', 'Belgien',
        'Switzerland', 'Schweiz', 'Austria', 'Osterreich', 'Sweden', 'Schweden', 'Norway', 'Norwegen',
        'Denmark', 'Danemark', 'Finland', 'Finnland', 'Poland', 'Polen', 'Czech Republic', 'Tschechien',
        'Czechia', 'Hungary', 'Ungarn', 'Croatia', 'Kroatien', 'Romania', 'Rumanien',
        'Ireland', 'Irland', 'Iceland', 'Island', 'New Zealand', 'Neuseeland',
        'Singapore', 'Singapur', 'Malaysia', 'Vietnam', 'Philippines', 'Philippinen',
        'Egypt', 'Agypten', 'Morocco', 'Marokko', 'South Africa', 'Sudafrika', 'Kenya', 'Kenia',
        'Argentina', 'Argentinien', 'Chile', 'Colombia', 'Kolumbien', 'Peru',
        'Russia', 'Russland', 'United Arab Emirates', 'UAE', 'Vereinigte Arabische Emirate',
        'Israel', 'Jordan', 'Jordanien', 'Taiwan', 'Hong Kong', 'Hongkong',
        'Cuba', 'Kuba', 'Costa Rica', 'Panama', 'Ecuador', 'Bolivia', 'Bolivien', 'Uruguay', 'Paraguay',
        'Luxembourg', 'Luxemburg', 'Malta', 'Cyprus', 'Zypern', 'Estonia', 'Estland',
        'Latvia', 'Lettland', 'Lithuania', 'Litauen', 'Slovakia', 'Slowakei', 'Slovenia', 'Slowenien',
        'Bulgaria', 'Bulgarien', 'Serbia', 'Serbien', 'Montenegro', 'Albania', 'Albanien',
        'Sri Lanka', 'Nepal', 'Cambodia', 'Kambodscha', 'Laos', 'Myanmar', 'Mongolia', 'Mongolei',
        'Saudi Arabia', 'Saudi-Arabien', 'Qatar', 'Katar', 'Oman', 'Bahrain', 'Kuwait',
        'Tanzania', 'Tansania', 'Ethiopia', 'Athiopien', 'Nigeria', 'Ghana', 'Tunisia', 'Tunesien',
        'Dominican Republic', 'Dominikanische Republik', 'Jamaica', 'Jamaika',
        'Ukraine', 'Georgia', 'Georgien', 'Armenia', 'Armenien', 'Pakistan', 'Bangladesh', 'Bangladesch',
        'Senegal', 'Mozambique', 'Mosambik', 'Moldova', 'Moldawien', 'Belarus', 'Weissrussland',
    ]);
    const countries = new Set();
    const cities = new Set();
    const coords = [];
    places.forEach(p => {
        if (p.lat && p.lng)
            coords.push({ lat: p.lat, lng: p.lng });
        if (p.address) {
            const parts = p.address.split(',').map(s => s.trim().replace(/\d{3,}/g, '').trim());
            for (const part of parts) {
                if (KNOWN_COUNTRIES.has(part)) {
                    countries.add(part);
                    break;
                }
            }
            const cityPart = parts.find(s => !KNOWN_COUNTRIES.has(s) && /^[A-Za-z\u00C0-\u00FF\s-]{2,}$/.test(s));
            if (cityPart)
                cities.add(cityPart);
        }
    });
    res.json({
        countries: [...countries],
        cities: [...cities],
        coords,
        totalTrips: tripStats?.trips || 0,
        totalDays: tripStats?.days || 0,
        totalPlaces: places.length,
    });
});
router.post('/mfa/verify-login', authLimiter, (req, res) => {
    const { mfa_token, code } = req.body;
    if (!mfa_token || !code) {
        return res.status(400).json({ error: 'Verification token and code are required' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(mfa_token, config_1.JWT_SECRET);
        if (decoded.purpose !== 'mfa_login') {
            return res.status(401).json({ error: 'Invalid verification token' });
        }
        const user = database_1.db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
        if (!user || !(user.mfa_enabled === 1 || user.mfa_enabled === true) || !user.mfa_secret) {
            return res.status(401).json({ error: 'Invalid session' });
        }
        const secret = (0, mfaCrypto_1.decryptMfaSecret)(user.mfa_secret);
        const tokenStr = String(code).replace(/\s/g, '');
        const ok = otplib_1.authenticator.verify({ token: tokenStr, secret });
        if (!ok) {
            return res.status(401).json({ error: 'Invalid verification code' });
        }
        database_1.db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
        const sessionToken = generateToken(user);
        const userSafe = stripUserForClient(user);
        res.json({ token: sessionToken, user: { ...userSafe, avatar_url: avatarUrl(user) } });
    }
    catch {
        return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
});
router.post('/mfa/setup', auth_1.authenticate, (req, res) => {
    const authReq = req;
    if (process.env.DEMO_MODE === 'true' && authReq.user.email === 'demo@nomad.app') {
        return res.status(403).json({ error: 'MFA is not available in demo mode.' });
    }
    const row = database_1.db.prepare('SELECT mfa_enabled FROM users WHERE id = ?').get(authReq.user.id);
    if (row?.mfa_enabled) {
        return res.status(400).json({ error: 'MFA is already enabled' });
    }
    let secret, otpauth_url;
    try {
        secret = otplib_1.authenticator.generateSecret();
        mfaSetupPending.set(authReq.user.id, { secret, exp: Date.now() + MFA_SETUP_TTL_MS });
        otpauth_url = otplib_1.authenticator.keyuri(authReq.user.email, 'TREK', secret);
    }
    catch (err) {
        console.error('[MFA] Setup error:', err);
        return res.status(500).json({ error: 'MFA setup failed' });
    }
    qrcode_1.default.toDataURL(otpauth_url)
        .then((qr_data_url) => {
        res.json({ secret, otpauth_url, qr_data_url });
    })
        .catch((err) => {
        console.error('[MFA] QR code generation error:', err);
        res.status(500).json({ error: 'Could not generate QR code' });
    });
});
router.post('/mfa/enable', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { code } = req.body;
    if (!code) {
        return res.status(400).json({ error: 'Verification code is required' });
    }
    const pending = getPendingMfaSecret(authReq.user.id);
    if (!pending) {
        return res.status(400).json({ error: 'No MFA setup in progress. Start the setup again.' });
    }
    const tokenStr = String(code).replace(/\s/g, '');
    const ok = otplib_1.authenticator.verify({ token: tokenStr, secret: pending });
    if (!ok) {
        return res.status(401).json({ error: 'Invalid verification code' });
    }
    const enc = (0, mfaCrypto_1.encryptMfaSecret)(pending);
    database_1.db.prepare('UPDATE users SET mfa_enabled = 1, mfa_secret = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(enc, authReq.user.id);
    mfaSetupPending.delete(authReq.user.id);
    res.json({ success: true, mfa_enabled: true });
});
router.post('/mfa/disable', auth_1.authenticate, rateLimiter(5, RATE_LIMIT_WINDOW), (req, res) => {
    const authReq = req;
    if (process.env.DEMO_MODE === 'true' && authReq.user.email === 'demo@nomad.app') {
        return res.status(403).json({ error: 'MFA cannot be changed in demo mode.' });
    }
    const { password, code } = req.body;
    if (!password || !code) {
        return res.status(400).json({ error: 'Password and authenticator code are required' });
    }
    const user = database_1.db.prepare('SELECT * FROM users WHERE id = ?').get(authReq.user.id);
    if (!user?.mfa_enabled || !user.mfa_secret) {
        return res.status(400).json({ error: 'MFA is not enabled' });
    }
    if (!user.password_hash || !bcryptjs_1.default.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Incorrect password' });
    }
    const secret = (0, mfaCrypto_1.decryptMfaSecret)(user.mfa_secret);
    const tokenStr = String(code).replace(/\s/g, '');
    const ok = otplib_1.authenticator.verify({ token: tokenStr, secret });
    if (!ok) {
        return res.status(401).json({ error: 'Invalid verification code' });
    }
    database_1.db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(authReq.user.id);
    mfaSetupPending.delete(authReq.user.id);
    res.json({ success: true, mfa_enabled: false });
});
exports.default = router;
//# sourceMappingURL=auth.js.map