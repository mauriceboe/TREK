import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { canAccessTrip, db } from './db/database';
import { authenticate } from './middleware/auth';
import { AuthRequest, Addon } from './types';

import authRoutes from './routes/auth';
import tripsRoutes from './routes/trips';
import legsRoutes from './routes/legs';
import recommendationsRoutes from './routes/recommendations';
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
import shareRoutes, { sharedRouter } from './routes/share';
import notificationsRoutes from './routes/notifications';
import vacayRoutes from './routes/vacay';
import atlasRoutes from './routes/atlas';
import immichRoutes from './routes/immich';
import mcpRoutes from './routes/mcp';

export function createApp() {
  const app = express();

  if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY) {
    app.set('trust proxy', parseInt(process.env.TRUST_PROXY as string) || 1);
  }

  const uploadsDir = path.join(__dirname, '../uploads');
  const photosDir = path.join(uploadsDir, 'photos');
  const filesDir = path.join(uploadsDir, 'files');
  const coversDir = path.join(uploadsDir, 'covers');
  const backupsDir = path.join(__dirname, '../data/backups');
  const tmpDir = path.join(__dirname, '../data/tmp');

  [uploadsDir, photosDir, filesDir, coversDir, backupsDir, tmpDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
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
    credentials: true,
  }));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://unpkg.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'https:', 'http:'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        objectSrc: ["'self'"],
        frameSrc: ["'self'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: shouldForceHttps ? [] : null,
      },
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

  app.use('/uploads/avatars', express.static(path.join(__dirname, '../uploads/avatars')));

  app.get('/uploads/:type/:filename', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const type = Array.isArray(req.params.type) ? req.params.type[0] : req.params.type;
    const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
    const allowedTypes = ['covers', 'files', 'photos'];
    if (!allowedTypes.includes(type)) return res.status(404).send('Not found');

    const safeName = path.basename(filename);
    const filePath = path.join(__dirname, '../uploads', type, safeName);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(__dirname, '../uploads', type))) {
      return res.status(403).send('Forbidden');
    }

    let tripId: number | null = null;
    if (type === 'covers') {
      const cover = db.prepare('SELECT id FROM trips WHERE cover_image = ?').get(`/uploads/covers/${safeName}`) as { id: number } | undefined;
      tripId = cover?.id ?? null;
    } else if (type === 'files') {
      const file = db.prepare('SELECT trip_id FROM trip_files WHERE filename IN (?, ?) LIMIT 1').get(safeName, `files/${safeName}`) as { trip_id: number } | undefined;
      tripId = file?.trip_id ?? null;
    } else if (type === 'photos') {
      const photo = db.prepare('SELECT trip_id FROM photos WHERE filename = ? LIMIT 1').get(safeName) as { trip_id: number } | undefined;
      tripId = photo?.trip_id ?? null;
    }

    if (!tripId || !canAccessTrip(tripId, authReq.user.id)) {
      return res.status(404).send('Not found');
    }

    if (!fs.existsSync(resolved)) return res.status(404).send('Not found');
    res.sendFile(resolved);
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/auth/oidc', oidcRoutes);
  app.use('/api/trips', tripsRoutes);
  app.use('/api/trips', legsRoutes);
  app.use('/api/trips', recommendationsRoutes);
  app.use('/api/trips/:tripId/days', daysRoutes);
  app.use('/api/trips/:tripId/accommodations', accommodationsRoutes);
  app.use('/api/trips/:tripId/places', placesRoutes);
  app.use('/api/trips/:tripId/packing', packingRoutes);
  app.use('/api/trips/:tripId/files', filesRoutes);
  app.use('/api/trips/:tripId/budget', budgetRoutes);
  app.use('/api/trips/:tripId/collab', collabRoutes);
  app.use('/api/trips/:tripId/share-link', shareRoutes);
  app.use('/api/trips/:tripId/reservations', reservationsRoutes);
  app.use('/api/trips/:tripId/days/:dayId/notes', dayNotesRoutes);
  app.get('/api/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));
  app.use('/api', assignmentsRoutes);
  app.use('/api/tags', tagsRoutes);
  app.use('/api/categories', categoriesRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/notifications', notificationsRoutes);
  app.use('/api/shared', sharedRouter);

  app.get('/api/addons', authenticate, (_req: Request, res: Response) => {
    const addons = db.prepare('SELECT id, name, type, icon, enabled FROM addons WHERE enabled = 1 ORDER BY sort_order').all() as Pick<Addon, 'id' | 'name' | 'type' | 'icon' | 'enabled'>[];
    res.json({ addons: addons.map(a => ({ ...a, enabled: !!a.enabled })) });
  });

  app.use('/api/addons/vacay', vacayRoutes);
  app.use('/api/addons/atlas', atlasRoutes);
  app.use('/api/integrations/immich', immichRoutes);

  app.use('/api/maps', mapsRoutes);
  app.use('/api/weather', weatherRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/backup', backupRoutes);
  app.use('/mcp', mcpRoutes);

  if (process.env.NODE_ENV === 'production') {
    const publicPath = path.join(__dirname, '../public');
    app.use(express.static(publicPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(publicPath, 'index.html'));
    });
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const known = err as Error & { code?: string; status?: number; type?: string };
    if (known.code === 'LIMIT_FILE_SIZE' || known.status === 413 || known.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request entity too large' });
    }
    if (/file type not allowed/i.test(err.message) || /only \.jpg, \.jpeg, \.png, \.gif, \.webp images are allowed/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export default createApp;
