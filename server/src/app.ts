import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';

import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './config';
import { logDebug, logWarn, logError } from './services/auditLog';
import { enforceGlobalMfaPolicy } from './middleware/mfaPolicy';
import { authenticate } from './middleware/auth';
import { db } from './db/database';

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
import vacayRoutes from './routes/vacay';
import atlasRoutes from './routes/atlas';
import immichRoutes from './routes/immich';
import notificationRoutes from './routes/notifications';
import shareRoutes from './routes/share';
import { mcpHandler } from './mcp';
import { Addon } from './types';

export function createApp(): express.Application {
  const app = express();

  // Trust first proxy (nginx/Docker) for correct req.ip
  if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY) {
    app.set('trust proxy', Number.parseInt(process.env.TRUST_PROXY) || 1);
  }

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

  app.use(cors({ origin: corsOrigin, credentials: true }));
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
          "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson"
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

  // Request logging with sensitive field redaction
  {
    const SENSITIVE_KEYS = new Set(['password', 'new_password', 'current_password', 'token', 'jwt', 'authorization', 'cookie', 'client_secret', 'mfa_token', 'code', 'smtp_pass']);
    const redact = (value: unknown): unknown => {
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return (value as unknown[]).map(redact);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v);
      }
      return out;
    };

    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path === '/api/health') return next();
      const startedAt = Date.now();
      res.on('finish', () => {
        const ms = Date.now() - startedAt;
        if (res.statusCode >= 500) {
          logError(`${req.method} ${req.path} ${res.statusCode} ${ms}ms ip=${req.ip}`);
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          logDebug(`${req.method} ${req.path} ${res.statusCode} ${ms}ms ip=${req.ip}`);
        } else if (res.statusCode >= 400) {
          logWarn(`${req.method} ${req.path} ${res.statusCode} ${ms}ms ip=${req.ip}`);
        }
        const q = Object.keys(req.query).length ? ` query=${JSON.stringify(redact(req.query))}` : '';
        const b = req.body && Object.keys(req.body).length ? ` body=${JSON.stringify(redact(req.body))}` : '';
        logDebug(`${req.method} ${req.path} ${res.statusCode} ${ms}ms ip=${req.ip}${q}${b}`);
      });
      next();
    });
  }

  // Static: avatars and covers are public
  app.use('/uploads/avatars', express.static(path.join(__dirname, '../uploads/avatars')));
  app.use('/uploads/covers', express.static(path.join(__dirname, '../uploads/covers')));

  // Photos require auth or valid share token
  app.get('/uploads/photos/:filename', (req: Request, res: Response) => {
    const safeName = path.basename(req.params.filename);
    const filePath = path.join(__dirname, '../uploads/photos', safeName);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(__dirname, '../uploads/photos'))) {
      return res.status(403).send('Forbidden');
    }
    if (!fs.existsSync(resolved)) return res.status(404).send('Not found');

    const authHeader = req.headers.authorization;
    const token = (req.query.token as string) || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);
    if (!token) return res.status(401).send('Authentication required');

    try {
      jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      const shareRow = db.prepare('SELECT id FROM share_tokens WHERE token = ?').get(token);
      if (!shareRow) return res.status(401).send('Authentication required');
    }
    res.sendFile(resolved);
  });

  // Block direct access to /uploads/files
  app.use('/uploads/files', (_req: Request, res: Response) => {
    res.status(401).send('Authentication required');
  });

  // API Routes
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
  app.get('/api/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));
  app.use('/api', assignmentsRoutes);
  app.use('/api/tags', tagsRoutes);
  app.use('/api/categories', categoriesRoutes);
  app.use('/api/admin', adminRoutes);

  // Addons list endpoint
  app.get('/api/addons', authenticate, (_req: Request, res: Response) => {
    const addons = db.prepare('SELECT id, name, type, icon, enabled FROM addons WHERE enabled = 1 ORDER BY sort_order').all() as Pick<Addon, 'id' | 'name' | 'type' | 'icon' | 'enabled'>[];
    res.json({ addons: addons.map(a => ({ ...a, enabled: !!a.enabled })) });
  });

  // Addon routes
  app.use('/api/addons/vacay', vacayRoutes);
  app.use('/api/addons/atlas', atlasRoutes);
  app.use('/api/integrations/immich', immichRoutes);
  app.use('/api/maps', mapsRoutes);
  app.use('/api/weather', weatherRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/backup', backupRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api', shareRoutes);

  // MCP endpoint
  app.post('/mcp', mcpHandler);
  app.get('/mcp', mcpHandler);
  app.delete('/mcp', mcpHandler);

  // Production static file serving
  if (process.env.NODE_ENV === 'production') {
    const publicPath = path.join(__dirname, '../public');
    app.use(express.static(publicPath, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      },
    }));
    app.get('*', (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(publicPath, 'index.html'));
    });
  }

  // Global error handler
  app.use((err: Error & { status?: number; statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (process.env.NODE_ENV === 'production') {
      console.error('Unhandled error:', err.message);
    } else {
      console.error('Unhandled error:', err);
    }
    const status = err.statusCode || 500;
    res.status(status).json({ error: 'Internal server error' });
  });

  return app;
}
