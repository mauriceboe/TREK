import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { enforceGlobalMfaPolicy } from './middleware/mfaPolicy';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';

const app = express();
const DEBUG = String(process.env.DEBUG || 'false').toLowerCase() === 'true';
const LOG_LVL = (process.env.LOG_LEVEL || 'info').toLowerCase();

// Trust first proxy (nginx/Docker) for correct req.ip
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY) {
  app.set('trust proxy', parseInt(process.env.TRUST_PROXY as string) || 1);
}

// Create upload directories on startup
const uploadsDir = path.join(__dirname, '../uploads');
const photosDir = path.join(uploadsDir, 'photos');
const filesDir = path.join(uploadsDir, 'files');
const coversDir = path.join(uploadsDir, 'covers');
const backupsDir = path.join(__dirname, '../data/backups');
const tmpDir = path.join(__dirname, '../data/tmp');

[uploadsDir, photosDir, filesDir, coversDir, backupsDir, tmpDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : null;

let corsOrigin: cors.CorsOptions['origin'];
if (allowedOrigins) {
  corsOrigin = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  };
} else if (process.env.NODE_ENV === 'production') {
  corsOrigin = false;
} else {
  corsOrigin = true;
}

const shouldForceHttps = process.env.FORCE_HTTPS === 'true';

app.use(cors({
  origin: corsOrigin,
  credentials: true
}));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: [
        "'self'", "ws:", "wss:",
        "https://nominatim.openstreetmap.org", "https://overpass-api.de",
        "https://places.googleapis.com", "https://api.openweathermap.org",
        "https://en.wikipedia.org", "https://commons.wikimedia.org",
        "https://*.basemaps.cartocdn.com", "https://*.tile.openstreetmap.org",
        "https://unpkg.com", "https://open-meteo.com", "https://api.open-meteo.com",
        "https://geocoding-api.open-meteo.com", "https://api.exchangerate-api.com",
      ],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: shouldForceHttps ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: shouldForceHttps ? { maxAge: 31536000, includeSubDomains: false } : false,
}));

// Redirect HTTP to HTTPS (opt-in via FORCE_HTTPS=true)
if (shouldForceHttps) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
    res.redirect(301, 'https://' + req.headers.host + req.url);
  });
}
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(enforceGlobalMfaPolicy);

{
  const { logInfo: _logInfo, logDebug: _logDebug, logWarn: _logWarn, logError: _logError } = require('./services/auditLog');
  const SENSITIVE_KEYS = new Set(['password', 'new_password', 'current_password', 'token', 'jwt', 'authorization', 'cookie', 'client_secret', 'mfa_token', 'code', 'smtp_pass']);
  const _redact = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(_redact);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : _redact(v);
    }
    return out;
  };

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/api/health') return next();

    const startedAt = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - startedAt;

      if (res.statusCode >= 500) {
        _logError(`${req.method} ${req.path} ${res.statusCode} ${ms}ms ip=${req.ip}`);
      } else if (res.statusCode === 401 || res.statusCode === 403) {
        _logDebug(`${req.method} ${req.path} ${res.statusCode} ${ms}ms ip=${req.ip}`);
      } else if (res.statusCode >= 400) {
        _logWarn(`${req.method} ${req.path} ${res.statusCode} ${ms}ms ip=${req.ip}`);
      }

      const q = Object.keys(req.query).length ? ` query=${JSON.stringify(_redact(req.query))}` : '';
      const b = req.body && Object.keys(req.body).length ? ` body=${JSON.stringify(_redact(req.body))}` : '';
      _logDebug(`${req.method} ${req.path} ${res.statusCode} ${ms}ms ip=${req.ip}${q}${b}`);
    });
    next();
  });
}

// Avatars are public (shown on login, sharing screens)
import { authenticate } from './middleware/auth';
app.use('/uploads/avatars', express.static(path.join(__dirname, '../uploads/avatars')));
app.use('/uploads/covers', express.static(path.join(__dirname, '../uploads/covers')));

// Serve uploaded photos — require auth token or valid share token
app.get('/uploads/photos/:filename', (req: Request, res: Response) => {
  const safeName = path.basename(req.params.filename);
  const filePath = path.join(__dirname, '../uploads/photos', safeName);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(__dirname, '../uploads/photos'))) {
    return res.status(403).send('Forbidden');
  }
  if (!fs.existsSync(resolved)) return res.status(404).send('Not found');

  // Allow if authenticated or if a valid share token is present
  const authHeader = req.headers.authorization;
  const token = req.query.token as string || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);
  if (!token) return res.status(401).send('Authentication required');

  try {
    const jwt = require('jsonwebtoken');
    jwt.verify(token, process.env.JWT_SECRET || require('./config').JWT_SECRET);
  } catch {
    // Check if it's a share token
    const shareRow = addonDb.prepare('SELECT id FROM share_tokens WHERE token = ?').get(token);
    if (!shareRow) return res.status(401).send('Authentication required');
  }
  res.sendFile(resolved);
});

// Block direct access to /uploads/files — served via authenticated /api/trips/:tripId/files/:id/download
app.use('/uploads/files', (_req: Request, res: Response) => {
  res.status(401).send('Authentication required');
});

// Routes
import authRoutes from './routes/auth';
import tripsRoutes from './routes/trips';
import daysRoutes, { accommodationsRouter as accommodationsRoutes } from './routes/days';
import placesRoutes from './routes/places';
import assignmentsRoutes from './routes/assignments';
import packingRoutes from './routes/packing';
import tagsRoutes from './routes/tags';
import categoriesRoutes from './routes/categories';
import adminRoutes from './routes/admin';
import mapsRoutes from './routes/maps';
import filesRoutes from './routes/files';
import reservationsRoutes from './routes/reservations';
import dayNotesRoutes from './routes/dayNotes';
import weatherRoutes from './routes/weather';
import settingsRoutes from './routes/settings';
import budgetRoutes from './routes/budget';
import collabRoutes from './routes/collab';
import backupRoutes from './routes/backup';
import oidcRoutes from './routes/oidc';
app.use('/api/auth', authRoutes);
app.use('/api/auth/oidc', oidcRoutes);
app.use('/api/trips', tripsRoutes);
app.use('/api/trips/:tripId/days', daysRoutes);
app.use('/api/trips/:tripId/accommodations', accommodationsRoutes);
app.use('/api/trips/:tripId/places', placesRoutes);
app.use('/api/trips/:tripId/packing', packingRoutes);
app.use('/api/trips/:tripId/files', filesRoutes);
app.use('/api/trips/:tripId/budget', budgetRoutes);
app.use('/api/trips/:tripId/collab', collabRoutes);
app.use('/api/trips/:tripId/reservations', reservationsRoutes);
app.use('/api/trips/:tripId/days/:dayId/notes', dayNotesRoutes);
app.get('/api/health', (req: Request, res: Response) => res.json({ status: 'ok' }));
app.use('/api', assignmentsRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/admin', adminRoutes);

// Public addons endpoint (authenticated but not admin-only)
import { authenticate as addonAuth } from './middleware/auth';
import {db as addonDb} from './db/database';
import { Addon } from './types';
app.get('/api/addons', addonAuth, (req: Request, res: Response) => {
  const addons = addonDb.prepare('SELECT id, name, type, icon, enabled FROM addons WHERE enabled = 1 ORDER BY sort_order').all() as Pick<Addon, 'id' | 'name' | 'type' | 'icon' | 'enabled'>[];
  res.json({ addons: addons.map(a => ({ ...a, enabled: !!a.enabled })) });
});

// Addon routes
import vacayRoutes from './routes/vacay';
app.use('/api/addons/vacay', vacayRoutes);
import atlasRoutes from './routes/atlas';
app.use('/api/addons/atlas', atlasRoutes);
import immichRoutes from './routes/immich';
app.use('/api/integrations/immich', immichRoutes);

app.use('/api/maps', mapsRoutes);
app.use('/api/weather', weatherRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/backup', backupRoutes);

import notificationRoutes from './routes/notifications';
app.use('/api/notifications', notificationRoutes);

import shareRoutes from './routes/share';
app.use('/api', shareRoutes);

// MCP endpoint (Streamable HTTP transport, per-user auth)
import { mcpHandler, closeMcpSessions } from './mcp';
app.post('/mcp', mcpHandler);
app.get('/mcp', mcpHandler);
app.delete('/mcp', mcpHandler);

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  const publicPath = path.join(__dirname, '../public');
  app.use(express.static(publicPath, {
    setHeaders: (res, filePath) => {
      // Never cache index.html so version updates are picked up immediately
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
  app.get('*', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(publicPath, 'index.html'));
  });
}

// Global error handler — do not leak stack traces in production
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV !== 'production') {
    console.error('Unhandled error:', err);
  } else {
    console.error('Unhandled error:', err.message);
  }
  res.status(500).json({ error: 'Internal server error' });
});

import * as scheduler from './scheduler';

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  const { logInfo: sLogInfo, logWarn: sLogWarn } = require('./services/auditLog');
  const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const origins = process.env.ALLOWED_ORIGINS || '(same-origin)';
  const banner = [
    '──────────────────────────────────────',
    '  TREK API started',
    `  Port:        ${PORT}`,
    `  Environment: ${process.env.NODE_ENV || 'development'}`,
    `  Timezone:    ${tz}`,
    `  Origins:     ${origins}`,
    `  Log level:   ${LOG_LVL}`,
    `  Log file:    /app/data/logs/trek.log`,
    `  PID:         ${process.pid}`,
    `  User:        uid=${process.getuid?.()} gid=${process.getgid?.()}`,
    '──────────────────────────────────────',
  ];
  banner.forEach(l => console.log(l));
  if (process.env.DEMO_MODE === 'true') sLogInfo('Demo mode: ENABLED');
  if (process.env.DEMO_MODE === 'true' && process.env.NODE_ENV === 'production') {
    sLogWarn('SECURITY WARNING: DEMO_MODE is enabled in production!');
  }
  scheduler.start();
  scheduler.startTripReminders();
  scheduler.startDemoReset();
  const { startTokenCleanup } = require('./services/ephemeralTokens');
  startTokenCleanup();
  import('./websocket').then(({ setupWebSocket }) => {
    setupWebSocket(server);
  });
});

// Graceful shutdown
function shutdown(signal: string): void {
  const { logInfo: sLogInfo, logError: sLogError } = require('./services/auditLog');
  sLogInfo(`${signal} received — shutting down gracefully...`);
  scheduler.stop();
  closeMcpSessions();
  server.close(() => {
    sLogInfo('HTTP server closed');
    const { closeDb } = require('./db/database');
    closeDb();
    sLogInfo('Shutdown complete');
    process.exit(0);
  });
  setTimeout(() => {
    sLogError('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
