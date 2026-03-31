"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const app = (0, express_1.default)();
// Trust first proxy (nginx/Docker) for correct req.ip
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY) {
    app.set('trust proxy', parseInt(process.env.TRUST_PROXY) || 1);
}
// Create upload directories on startup
const uploadsDir = path_1.default.join(__dirname, '../data/uploads');
const photosDir = path_1.default.join(uploadsDir, 'photos');
const filesDir = path_1.default.join(uploadsDir, 'files');
const coversDir = path_1.default.join(uploadsDir, 'covers');
const backupsDir = path_1.default.join(__dirname, '../data/backups');
const tmpDir = path_1.default.join(__dirname, '../data/tmp');
[uploadsDir, photosDir, filesDir, coversDir, backupsDir, tmpDir].forEach(dir => {
    if (!fs_1.default.existsSync(dir))
        fs_1.default.mkdirSync(dir, { recursive: true });
});
// Middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : null;
let corsOrigin;
if (allowedOrigins) {
    // Explicit whitelist from env var
    corsOrigin = (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin))
            callback(null, true);
        else
            callback(new Error('Not allowed by CORS'));
    };
}
else if (process.env.NODE_ENV === 'production') {
    // Production: same-origin only (Express serves the static client)
    corsOrigin = false;
}
else {
    // Development: allow all origins (needed for Vite dev server)
    corsOrigin = true;
}
const shouldForceHttps = process.env.FORCE_HTTPS === 'true';
app.use((0, cors_1.default)({
    origin: corsOrigin,
    credentials: true
}));
app.use((0, helmet_1.default)({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
            imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
            connectSrc: ["'self'", "ws:", "wss:", "https:", "http:"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
            objectSrc: ["'self'"],
            frameSrc: ["'self'"],
            frameAncestors: ["'self'"],
            upgradeInsecureRequests: shouldForceHttps ? [] : null
        }
    },
    crossOriginEmbedderPolicy: false,
    hsts: shouldForceHttps ? { maxAge: 31536000, includeSubDomains: false } : false,
}));
// Redirect HTTP to HTTPS (opt-in via FORCE_HTTPS=true)
if (shouldForceHttps) {
    app.use((req, res, next) => {
        if (req.secure || req.headers['x-forwarded-proto'] === 'https')
            return next();
        res.redirect(301, 'https://' + req.headers.host + req.url);
    });
}
app.use(express_1.default.json({ limit: '100kb' }));
app.use(express_1.default.urlencoded({ extended: true }));
// Avatars are public (shown on login, sharing screens)
app.use('/uploads/avatars', express_1.default.static(path_1.default.join(__dirname, '../data/uploads/avatars')));
// All other uploads require authentication
app.get('/uploads/:type/:filename', (req, res) => {
    const { type, filename } = req.params;
    const allowedTypes = ['covers', 'files', 'photos'];
    if (!allowedTypes.includes(type))
        return res.status(404).send('Not found');
    // Prevent path traversal
    const safeName = path_1.default.basename(filename);
    const filePath = path_1.default.join(__dirname, '../data/uploads', type, safeName);
    const resolved = path_1.default.resolve(filePath);
    if (!resolved.startsWith(path_1.default.resolve(__dirname, '../data/uploads', type))) {
        return res.status(403).send('Forbidden');
    }
    if (!fs_1.default.existsSync(resolved))
        return res.status(404).send('Not found');
    res.sendFile(resolved);
});
// Routes
const auth_1 = __importDefault(require("./routes/auth"));
const trips_1 = __importDefault(require("./routes/trips"));
const days_1 = __importStar(require("./routes/days"));
const places_1 = __importDefault(require("./routes/places"));
const assignments_1 = __importDefault(require("./routes/assignments"));
const packing_1 = __importDefault(require("./routes/packing"));
const tags_1 = __importDefault(require("./routes/tags"));
const categories_1 = __importDefault(require("./routes/categories"));
const admin_1 = __importDefault(require("./routes/admin"));
const maps_1 = __importDefault(require("./routes/maps"));
const files_1 = __importDefault(require("./routes/files"));
const reservations_1 = __importDefault(require("./routes/reservations"));
const dayNotes_1 = __importDefault(require("./routes/dayNotes"));
const weather_1 = __importDefault(require("./routes/weather"));
const settings_1 = __importDefault(require("./routes/settings"));
const budget_1 = __importDefault(require("./routes/budget"));
const collab_1 = __importDefault(require("./routes/collab"));
const backup_1 = __importDefault(require("./routes/backup"));
const oidc_1 = __importDefault(require("./routes/oidc"));
const kosten_1 = __importDefault(require("./routes/kosten"));
app.use('/api/auth', auth_1.default);
app.use('/api/auth/oidc', oidc_1.default);
app.use('/api/trips', trips_1.default);
app.use('/api/trips/:tripId/days', days_1.default);
app.use('/api/trips/:tripId/accommodations', days_1.accommodationsRouter);
app.use('/api/trips/:tripId/places', places_1.default);
app.use('/api/trips/:tripId/packing', packing_1.default);
app.use('/api/trips/:tripId/files', files_1.default);
app.use('/api/trips/:tripId/budget', budget_1.default);
app.use('/api/trips/:tripId/kosten', kosten_1.default);
app.use('/api/trips/:tripId/collab', collab_1.default);
app.use('/api/trips/:tripId/reservations', reservations_1.default);
app.use('/api/trips/:tripId/days/:dayId/notes', dayNotes_1.default);
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api', assignments_1.default);
app.use('/api/tags', tags_1.default);
app.use('/api/categories', categories_1.default);
app.use('/api/admin', admin_1.default);
// Public addons endpoint (authenticated but not admin-only)
const auth_2 = require("./middleware/auth");
const database_1 = require("./db/database");
app.get('/api/addons', auth_2.authenticate, (req, res) => {
    const addons = database_1.db.prepare('SELECT id, name, type, icon, enabled FROM addons WHERE enabled = 1 ORDER BY sort_order').all();
    res.json({ addons: addons.map(a => ({ ...a, enabled: !!a.enabled })) });
});
// Addon routes
const vacay_1 = __importDefault(require("./routes/vacay"));
app.use('/api/addons/vacay', vacay_1.default);
const atlas_1 = __importDefault(require("./routes/atlas"));
app.use('/api/addons/atlas', atlas_1.default);
const immich_1 = __importDefault(require("./routes/immich"));
app.use('/api/integrations/immich', immich_1.default);
app.use('/api/maps', maps_1.default);
app.use('/api/weather', weather_1.default);
app.use('/api/settings', settings_1.default);
app.use('/api/backup', backup_1.default);
// Serve static files in production
if (process.env.NODE_ENV === 'production') {
    const publicPath = path_1.default.join(__dirname, '../public');
    app.use(express_1.default.static(publicPath));
    app.get('*', (req, res) => {
        res.sendFile(path_1.default.join(publicPath, 'index.html'));
    });
}
// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});
const scheduler = __importStar(require("./scheduler"));
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
    console.log(`TREK API running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    if (process.env.DEMO_MODE === 'true')
        console.log('Demo mode: ENABLED');
    if (process.env.DEMO_MODE === 'true' && process.env.NODE_ENV === 'production') {
        console.warn('[SECURITY WARNING] DEMO_MODE is enabled in production! Demo credentials are publicly exposed.');
    }
    scheduler.start();
    scheduler.startDemoReset();
    Promise.resolve().then(() => __importStar(require('./websocket'))).then(({ setupWebSocket }) => {
        setupWebSocket(server);
    });
});
// Graceful shutdown
function shutdown(signal) {
    console.log(`\n${signal} received — shutting down gracefully...`);
    scheduler.stop();
    server.close(() => {
        console.log('HTTP server closed');
        const { closeDb } = require('./db/database');
        closeDb();
        console.log('Shutdown complete');
        process.exit(0);
    });
    // Force exit after 10s if connections don't close
    setTimeout(() => {
        console.error('Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
exports.default = app;
//# sourceMappingURL=index.js.map