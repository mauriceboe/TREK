import 'dotenv/config';
import { JWT_SECRET_IS_GENERATED } from './config';
import express, { Request, Response, NextFunction } from 'express';
import { enforceGlobalMfaPolicy } from './middleware/mfaPolicy';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';

const app = express();
const DEBUG = String(process.env.DEBUG || 'false').toLowerCase() === 'true';

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
  ? process.env.ALLOWED_ORIGINS.split(',')
  : null;

let corsOrigin: cors.CorsOptions['origin'];
if (allowedOrigins) {
  // Explicit whitelist from env var
  corsOrigin = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  };
} else if (process.env.NODE_ENV === 'production') {
  // Production: same-origin only (Express serves the static client)
  corsOrigin = false;
} else {
  // Development: allow all origins (needed for Vite dev server)
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
        "https://geocoding-api.open-meteo.com",
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

app.use(enforceGlobalMfaPolicy);

if (DEBUG) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    const requestId = Math.random().toString(36).slice(2, 10);
    const redact = (value: unknown): unknown => {
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(redact);
      const hidden = new Set(['password', 'token', 'jwt', 'authorization', 'cookie', 'client_secret', 'mfa_token', 'code']);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = hidden.has(k.toLowerCase()) ? '[REDACTED]' : redact(v);
      }
      return out;
    };

    const safeQuery = redact(req.query);
    const safeBody = redact(req.body);
    console.log(`[DEBUG][REQ ${requestId}] ${req.method} ${req.originalUrl} ip=${req.ip} query=${JSON.stringify(safeQuery)} body=${JSON.stringify(safeBody)}`);

    res.on('finish', () => {
      const elapsedMs = Date.now() - startedAt;
      console.log(`[DEBUG][RES ${requestId}] ${req.method} ${req.originalUrl} status=${res.statusCode} elapsed_ms=${elapsedMs}`);
    });

    next();
  });
}

// Avatars are public (shown on login, sharing screens)
import { authenticate } from './middleware/auth';
app.use('/uploads/avatars', express.static(path.join(__dirname, '../uploads/avatars')));
app.use('/uploads/covers', express.static(path.join(__dirname, '../uploads/covers')));

// Serve uploaded files (UUIDs are unguessable, path traversal protected)
app.get('/uploads/:type/:filename', (req: Request, res: Response) => {
  const { type, filename } = req.params;
  const allowedTypes = ['covers', 'files', 'photos'];
  if (!allowedTypes.includes(type)) return res.status(404).send('Not found');

  // Prevent path traversal
  const safeName = path.basename(filename);
  const filePath = path.join(__dirname, '../uploads', type, safeName);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(__dirname, '../uploads', type))) {
    return res.status(403).send('Forbidden');
  }

  if (!fs.existsSync(resolved)) return res.status(404).send('Not found');
  res.sendFile(resolved);
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
import { db as addonDb } from './db/database';
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
  console.log(`TREK API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Debug logs: ${DEBUG ? 'ENABLED' : 'disabled'}`);
  if (JWT_SECRET_IS_GENERATED) {
    console.warn('[SECURITY WARNING] JWT_SECRET was auto-generated. Sessions will not persist across restarts. Set JWT_SECRET env var for production use.');
  }
  if (process.env.DEMO_MODE === 'true') console.log('Demo mode: ENABLED');
  if (process.env.DEMO_MODE === 'true' && process.env.NODE_ENV === 'production') {
    console.warn('[SECURITY WARNING] DEMO_MODE is enabled in production! Demo credentials are publicly exposed.');
  }
  scheduler.start();
  scheduler.startDemoReset();
  import('./websocket').then(({ setupWebSocket }) => {
    setupWebSocket(server);
  });
});

// Graceful shutdown
function shutdown(signal: string): void {
  console.log(`\n${signal} received — shutting down gracefully...`);
  scheduler.stop();
  closeMcpSessions();
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

export default app;
