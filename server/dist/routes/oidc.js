"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const crypto_1 = __importDefault(require("crypto"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = require("../db/database");
const config_1 = require("../config");
const router = express_1.default.Router();
const AUTH_CODE_TTL = 60000; // 1 minute
const AUTH_CODE_CLEANUP = 30000; // 30 seconds
const STATE_TTL = 5 * 60 * 1000; // 5 minutes
const STATE_CLEANUP = 60 * 1000; // 1 minute
const authCodes = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [code, entry] of authCodes) {
        if (now - entry.created > AUTH_CODE_TTL)
            authCodes.delete(code);
    }
}, AUTH_CODE_CLEANUP);
const pendingStates = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [state, data] of pendingStates) {
        if (now - data.createdAt > STATE_TTL)
            pendingStates.delete(state);
    }
}, STATE_CLEANUP);
function getOidcConfig() {
    const get = (key) => database_1.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)?.value || null;
    const issuer = process.env.OIDC_ISSUER || get('oidc_issuer');
    const clientId = process.env.OIDC_CLIENT_ID || get('oidc_client_id');
    const clientSecret = process.env.OIDC_CLIENT_SECRET || get('oidc_client_secret');
    const displayName = process.env.OIDC_DISPLAY_NAME || get('oidc_display_name') || 'SSO';
    if (!issuer || !clientId || !clientSecret)
        return null;
    return { issuer: issuer.replace(/\/+$/, ''), clientId, clientSecret, displayName };
}
let discoveryCache = null;
let discoveryCacheTime = 0;
const DISCOVERY_TTL = 60 * 60 * 1000; // 1 hour
async function discover(issuer) {
    if (discoveryCache && Date.now() - discoveryCacheTime < DISCOVERY_TTL && discoveryCache._issuer === issuer) {
        return discoveryCache;
    }
    const res = await (0, node_fetch_1.default)(`${issuer}/.well-known/openid-configuration`);
    if (!res.ok)
        throw new Error('Failed to fetch OIDC discovery document');
    const doc = await res.json();
    doc._issuer = issuer;
    discoveryCache = doc;
    discoveryCacheTime = Date.now();
    return doc;
}
function generateToken(user) {
    return jsonwebtoken_1.default.sign({ id: user.id, username: user.username, email: user.email, role: user.role }, config_1.JWT_SECRET, { expiresIn: '24h' });
}
function frontendUrl(path) {
    const base = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173';
    return base + path;
}
router.get('/login', async (req, res) => {
    const config = getOidcConfig();
    if (!config)
        return res.status(400).json({ error: 'OIDC not configured' });
    if (config.issuer && !config.issuer.startsWith('https://') && process.env.NODE_ENV === 'production') {
        return res.status(400).json({ error: 'OIDC issuer must use HTTPS in production' });
    }
    try {
        const doc = await discover(config.issuer);
        const state = crypto_1.default.randomBytes(32).toString('hex');
        const proto = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const redirectUri = `${proto}://${host}/api/auth/oidc/callback`;
        pendingStates.set(state, { createdAt: Date.now(), redirectUri });
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: config.clientId,
            redirect_uri: redirectUri,
            scope: 'openid email profile',
            state,
        });
        res.redirect(`${doc.authorization_endpoint}?${params}`);
    }
    catch (err) {
        console.error('[OIDC] Login error:', err instanceof Error ? err.message : err);
        res.status(500).json({ error: 'OIDC login failed' });
    }
});
router.get('/callback', async (req, res) => {
    const { code, state, error: oidcError } = req.query;
    if (oidcError) {
        console.error('[OIDC] Provider error:', oidcError);
        return res.redirect(frontendUrl('/login?oidc_error=' + encodeURIComponent(oidcError)));
    }
    if (!code || !state) {
        return res.redirect(frontendUrl('/login?oidc_error=missing_params'));
    }
    const pending = pendingStates.get(state);
    if (!pending) {
        return res.redirect(frontendUrl('/login?oidc_error=invalid_state'));
    }
    pendingStates.delete(state);
    const config = getOidcConfig();
    if (!config)
        return res.redirect(frontendUrl('/login?oidc_error=not_configured'));
    if (config.issuer && !config.issuer.startsWith('https://') && process.env.NODE_ENV === 'production') {
        return res.redirect(frontendUrl('/login?oidc_error=issuer_not_https'));
    }
    try {
        const doc = await discover(config.issuer);
        const tokenRes = await (0, node_fetch_1.default)(doc.token_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: pending.redirectUri,
                client_id: config.clientId,
                client_secret: config.clientSecret,
            }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenRes.ok || !tokenData.access_token) {
            console.error('[OIDC] Token exchange failed:', tokenData);
            return res.redirect(frontendUrl('/login?oidc_error=token_failed'));
        }
        const userInfoRes = await (0, node_fetch_1.default)(doc.userinfo_endpoint, {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const userInfo = await userInfoRes.json();
        if (!userInfo.email) {
            return res.redirect(frontendUrl('/login?oidc_error=no_email'));
        }
        const email = userInfo.email.toLowerCase();
        const name = userInfo.name || userInfo.preferred_username || email.split('@')[0];
        const sub = userInfo.sub;
        let user = database_1.db.prepare('SELECT * FROM users WHERE oidc_sub = ? AND oidc_issuer = ?').get(sub, config.issuer);
        if (!user) {
            user = database_1.db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);
        }
        if (user) {
            if (!user.oidc_sub) {
                database_1.db.prepare('UPDATE users SET oidc_sub = ?, oidc_issuer = ? WHERE id = ?').run(sub, config.issuer, user.id);
            }
        }
        else {
            const userCount = database_1.db.prepare('SELECT COUNT(*) as count FROM users').get().count;
            const isFirstUser = userCount === 0;
            if (!isFirstUser) {
                const setting = database_1.db.prepare("SELECT value FROM app_settings WHERE key = 'allow_registration'").get();
                if (setting?.value === 'false') {
                    return res.redirect(frontendUrl('/login?oidc_error=registration_disabled'));
                }
            }
            const role = isFirstUser ? 'admin' : 'user';
            const randomPass = crypto_1.default.randomBytes(32).toString('hex');
            const bcrypt = require('bcryptjs');
            const hash = bcrypt.hashSync(randomPass, 10);
            let username = name.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 30) || 'user';
            const existing = database_1.db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username);
            if (existing)
                username = `${username}_${Date.now() % 10000}`;
            const result = database_1.db.prepare('INSERT INTO users (username, email, password_hash, role, oidc_sub, oidc_issuer) VALUES (?, ?, ?, ?, ?, ?)').run(username, email, hash, role, sub, config.issuer);
            user = { id: Number(result.lastInsertRowid), username, email, role };
        }
        database_1.db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
        const token = generateToken(user);
        const { v4: uuidv4 } = require('uuid');
        const authCode = uuidv4();
        authCodes.set(authCode, { token, created: Date.now() });
        res.redirect(frontendUrl('/login?oidc_code=' + authCode));
    }
    catch (err) {
        console.error('[OIDC] Callback error:', err);
        res.redirect(frontendUrl('/login?oidc_error=server_error'));
    }
});
router.get('/exchange', (req, res) => {
    const { code } = req.query;
    if (!code)
        return res.status(400).json({ error: 'Code required' });
    const entry = authCodes.get(code);
    if (!entry)
        return res.status(400).json({ error: 'Invalid or expired code' });
    authCodes.delete(code);
    if (Date.now() - entry.created > AUTH_CODE_TTL)
        return res.status(400).json({ error: 'Code expired' });
    res.json({ token: entry.token });
});
exports.default = router;
//# sourceMappingURL=oidc.js.map