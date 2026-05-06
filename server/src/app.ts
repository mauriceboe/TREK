import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';

import { logDebug, logWarn, logError } from './services/auditLog';
import { enforceGlobalMfaPolicy } from './middleware/mfaPolicy';
import { authenticate, verifyJwtAndLoadUser } from './middleware/auth';
import { db } from './db/database';

import authRoutes from './routes/auth';
import tripsRoutes from './routes/trips';
import daysRoutes, { accommodationsRouter as accommodationsRoutes } from './routes/days';
import placesRoutes from './routes/places';
import assignmentsRoutes from './routes/assignments';
import packingRoutes from './routes/packing';
import todoRoutes from './routes/todo';
import tagsRoutes from './routes/tags';
import categoriesRoutes from './routes/categories';
import adminRoutes from './routes/admin';
import mapsRoutes from './routes/maps';
import airportsRoutes from './routes/airports';
import filesRoutes from './routes/files';
import reservationsRoutes from './routes/reservations';
import dayNotesRoutes from './routes/dayNotes';
import weatherRoutes from './routes/weather';
import settingsRoutes from './routes/settings';
import budgetRoutes from './routes/budget';
import collabRoutes from './routes/collab';
import backupRoutes from './routes/backup';
import oidcRoutes from './routes/oidc';
import { oauthPublicRouter, oauthApiRouter } from './routes/oauth';
import vacayRoutes from './routes/vacay';
import atlasRoutes from './routes/atlas';
import memoriesRoutes from './routes/memories/unified';
import photoRoutes from './routes/photos';
import notificationRoutes from './routes/notifications';
import shareRoutes from './routes/share';
import journeyRoutes from './routes/journey';
import journeyPublicRoutes from './routes/journeyPublic';
import publicConfigRoutes from './routes/publicConfig';
import systemNoticesRoutes from './routes/systemNotices';
import { mcpHandler } from './mcp';
import { trekOAuthProvider, trekClientsStore } from './mcp/oauthProvider';
import { Addon } from './types';
import { getPhotoProviderConfig } from './services/memories/helpersService';
import { getCollabFeatures } from './services/adminService';
import { isAddonEnabled } from './services/adminService';
import { ADDON_IDS } from './addons';
import { ALL_SCOPES } from './mcp/scopes';
import { getAppUrl } from './services/oidcService';
import { mcpAuthMetadataRouter } from '@modelcontextprotocol/sdk/server/auth/router';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth';

export function createApp(): express.Application {
  const app = express();

  // Trust first proxy (nginx/Docker) for correct req.ip
  if (process.env.NODE_ENV?.toLowerCase() === 'production' || process.env.TRUST_PROXY) {
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
  } else if (process.env.NODE_ENV?.toLowerCase() === 'production') {
    corsOrigin = false;
  } else {
    corsOrigin = true;
  }

  const shouldForceHttps = process.env.FORCE_HTTPS?.toLowerCase() === 'true';
  // HSTS is worth enabling any time we're serving production traffic,
  // not only when FORCE_HTTPS is set. Self-hosters behind Traefik /
  // Caddy / Cloudflare Tunnel typically leave FORCE_HTTPS unset (the
  // proxy handles the redirect for them), and the previous "HSTS off by
  // default" meant those instances never advertised HSTS at all.
  //
  // `includeSubDomains` stays OFF by default on purpose: an instance
  // running on an apex domain would otherwise force HTTPS on every
  // sibling subdomain the same operator may still be running over plain
  // HTTP. Operators who want the stricter policy opt in with
  // `HSTS_INCLUDE_SUBDOMAINS=true`.
  const hstsActive = shouldForceHttps || process.env.NODE_ENV === 'production';
  const hstsIncludeSubdomains = process.env.HSTS_INCLUDE_SUBDOMAINS === 'true';

  // RFC 8414 / RFC 9728 / RFC 7591: discovery docs and DCR are world-readable/writable.
  // /mcp needs open CORS so external MCP clients (ChatGPT, Claude.ai, Inspector) can call it
  // with Bearer tokens from any origin. /oauth/register and /oauth/authorize need it for
  // browser-based DCR/authorization preflights — the global cors({ origin: false }) would
  // answer OPTIONS without Access-Control-Allow-Origin before the SDK's own cors() runs.
  // All /.well-known/* paths get open CORS so clients probing openid-configuration or the
  // RFC 8414 path-suffixed AS metadata form don't get CORS-blocked (they get 404 JSON instead).
  app.use(
      (req: Request, _res: Response, next: NextFunction) => {
        if (
            req.path.startsWith('/.well-known/') ||
            req.path === '/oauth/register' ||
            req.path === '/oauth/authorize' ||
            req.path === '/oauth/userinfo' ||
            req.path === '/mcp'
        ) {
          cors({ origin: '*', credentials: false })(req, _res, next);
        } else {
          next();
        }
      },
  );
  app.use(cors({ origin: corsOrigin, credentials: true }));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
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
          "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson",
          "https://router.project-osrm.org/route/v1/",
          "https://api.mapbox.com", "https://*.tiles.mapbox.com", "https://events.mapbox.com"
        ],
        workerSrc: ["'self'", "blob:"],
        childSrc: ["'self'", "blob:"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: shouldForceHttps ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts: hstsActive ? { maxAge: 31536000, includeSubDomains: hstsIncludeSubdomains } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));

  if (shouldForceHttps) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path === '/api/health') return next();
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

  // Static: avatars, covers, and journey photos.
  //
  // Security model (audit SEC-M9): these paths are unauthenticated by
  // design. All filenames are server-chosen UUID v4 (see `uuid()` in
  // the multer storage config for avatars / covers / journey uploads),
  // which gives each asset >122 bits of namespace entropy — not
  // guessable via enumeration. An attacker would need to have already
  // seen the URL (email, shared journey, etc.) to request the file.
  //
  // Moving these behind auth would also break:
  //   - Unauthenticated trip-card rendering on public share links
  //   - Journey public-share pages (/public/journey/:token)
  //   - Email-embedded avatars
  //
  // The `/uploads/photos/...` route below is DIFFERENT: photo URLs are
  // not embedded in unauthenticated UI contexts, so that endpoint IS
  // gated (session JWT with pv, or a share token scoped to the photo's
  // trip).
  app.use('/uploads/avatars', express.static(path.join(__dirname, '../uploads/avatars')));
  app.use('/uploads/covers', express.static(path.join(__dirname, '../uploads/covers')));
  app.use('/uploads/journey', express.static(path.join(__dirname, '../uploads/journey')));

  // Photos require either a valid logged-in session (via JWT with the
  // password_version gate) OR a share token that covers the SPECIFIC
  // photo's trip. Previously any share token for any trip could request
  // any photo filename by UUID — fine in practice because UUIDs are
  // unguessable, but the auth model was wrong.
  app.get('/uploads/photos/:filename', (req: Request, res: Response) => {
    const safeName = path.basename(req.params.filename);
    const filePath = path.join(__dirname, '../uploads/photos', safeName);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(__dirname, '../uploads/photos'))) {
      return res.status(403).send('Forbidden');
    }
    // existsSync here is cheap and avoids a sendFile error frame; kept
    // sync because the handler is already short-lived.
    if (!fs.existsSync(resolved)) return res.status(404).send('Not found');

    const authHeader = req.headers.authorization;
    const rawToken = (req.query.token as string) || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);
    if (!rawToken) return res.status(401).send('Authentication required');

    // JWT session path (with pv check).
    const user = verifyJwtAndLoadUser(rawToken);
    if (user) return res.sendFile(resolved);

    // Share-token path: require the token to cover the exact trip the
    // photo belongs to. Expired tokens fall through to 401.
    const photo = db.prepare('SELECT trip_id FROM photos WHERE filename = ?').get(safeName) as { trip_id: number } | undefined;
    if (!photo) return res.status(401).send('Authentication required');

    const share = db.prepare(
        "SELECT trip_id FROM share_tokens WHERE token = ? AND (expires_at IS NULL OR expires_at > datetime('now'))"
    ).get(rawToken) as { trip_id: number } | undefined;
    if (!share || share.trip_id !== photo.trip_id) {
      return res.status(401).send('Authentication required');
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
  app.use('/api/trips/:tripId/todo', todoRoutes);
  app.use('/api/trips/:tripId/files', filesRoutes);
  app.use('/api/trips/:tripId/budget', budgetRoutes);
  app.use('/api/trips/:tripId/collab', collabRoutes);
  app.use('/api/trips/:tripId/reservations', reservationsRoutes);
  app.use('/api/trips/:tripId/days/:dayId/notes', dayNotesRoutes);
  app.get('/api/health', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate')
    res.json({ status: 'ok' })
  });
  app.use('/api/config', publicConfigRoutes);
  app.use('/api', assignmentsRoutes);
  app.use('/api/tags', tagsRoutes);
  app.use('/api/categories', categoriesRoutes);
  app.use('/api/admin', adminRoutes);

  // Addons list endpoint
  app.get('/api/addons', authenticate, (_req: Request, res: Response) => {
    const addons = db.prepare('SELECT id, name, type, icon, enabled FROM addons WHERE enabled = 1 ORDER BY sort_order').all() as Pick<Addon, 'id' | 'name' | 'type' | 'icon' | 'enabled'>[];
    const providers = db.prepare(`
      SELECT id, name, icon, enabled, sort_order
      FROM photo_providers
      WHERE enabled = 1
      ORDER BY sort_order, id
    `).all() as Array<{ id: string; name: string; icon: string; enabled: number; sort_order: number }>;
    const fields = db.prepare(`
      SELECT provider_id, field_key, label, input_type, placeholder, hint, required, secret, settings_key, payload_key, sort_order
      FROM photo_provider_fields
      ORDER BY sort_order, id
    `).all() as Array<{
      provider_id: string;
      field_key: string;
      label: string;
      input_type: string;
      placeholder?: string | null;
      hint?: string | null;
      required: number;
      secret: number;
      settings_key?: string | null;
      payload_key?: string | null;
      sort_order: number;
    }>;

    const fieldsByProvider = new Map<string, typeof fields>();
    for (const field of fields) {
      const arr = fieldsByProvider.get(field.provider_id) || [];
      arr.push(field);
      fieldsByProvider.set(field.provider_id, arr);
    }

    res.json({
      collabFeatures: getCollabFeatures(),
      addons: [
        ...addons.map(a => ({ ...a, enabled: !!a.enabled })),
        ...providers.map(p => ({
          id: p.id,
          name: p.name,
          type: 'photo_provider',
          icon: p.icon,
          enabled: !!p.enabled,
          config: getPhotoProviderConfig(p.id),
          fields: (fieldsByProvider.get(p.id) || []).map(f => ({
            key: f.field_key,
            label: f.label,
            input_type: f.input_type,
            placeholder: f.placeholder || '',
            hint: f.hint || null,
            required: !!f.required,
            secret: !!f.secret,
            settings_key: f.settings_key || null,
            payload_key: f.payload_key || null,
            sort_order: f.sort_order,
          })),
        })),
      ],
    });
  });

  // Addon routes
  app.use('/api/addons/vacay', vacayRoutes);
  app.use('/api/addons/atlas', atlasRoutes);
  app.use('/api/journeys', (req, res, next) => {
    if (!isAddonEnabled(ADDON_IDS.JOURNEY)) return res.status(404).json({ error: 'Journey addon is not enabled' });
    next();
  }, journeyRoutes);
  app.use('/api/public/journey', journeyPublicRoutes);
  app.use('/api/integrations/memories', memoriesRoutes);
  app.use('/api/photos', photoRoutes);
  app.use('/api/maps', mapsRoutes);
  app.use('/api/airports', airportsRoutes);
  app.use('/api/weather', weatherRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/system-notices', systemNoticesRoutes);
  app.use('/api/backup', backupRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api', shareRoutes);

  // OAuth 2.1 — public endpoints
  // Gate: 404 when MCP addon is disabled (M2 — prevents feature fingerprinting)
  const mcpAddonGate = (_req: Request, res: Response, next: NextFunction) => {
    if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(404).end();
    next();
  };

  // OAuth 2.1 — SPA-facing authenticated endpoints (/api/oauth/*)
  // Mounted first: per-route 403 checks inside oauthApiRouter are the gate, not mcpAddonGate
  app.use('/api/oauth', oauthApiRouter);

  // SDK metadata router — built lazily on first request so getAppUrl() (which queries the DB)
  // is not called at createApp() time, before test tables have been created.
  // mcpAuthMetadataRouter serves:
  //   /.well-known/oauth-authorization-server   — RFC 8414 AS metadata
  //   /.well-known/oauth-protected-resource/mcp — RFC 9728 path-based PRM (fixes issue #959 bug 1)
  let _oauthMetadata: OAuthMetadata | null = null;
  let _sdkMetaRouter: express.Router | null = null;

  function getOAuthMetadata(): OAuthMetadata {
    if (_oauthMetadata) return _oauthMetadata;
    const base = (getAppUrl() || 'http://localhost:3001').replace(/\/+$/, '');
    _oauthMetadata = {
      issuer:                                base,
      authorization_endpoint:                `${base}/oauth/authorize`,
      token_endpoint:                        `${base}/oauth/token`,
      revocation_endpoint:                   `${base}/oauth/revoke`,
      registration_endpoint:                 `${base}/oauth/register`,
      response_types_supported:              ['code'],
      grant_types_supported:                 ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported:      ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      scopes_supported:                      ALL_SCOPES,
    };
    return _oauthMetadata;
  }

  function getMetaRouter(): express.Router {
    if (_sdkMetaRouter) return _sdkMetaRouter;
    const metadata = getOAuthMetadata();
    _sdkMetaRouter = mcpAuthMetadataRouter({
      oauthMetadata: metadata,
      resourceServerUrl: new URL(`${metadata.issuer}/mcp`),
      scopesSupported: ALL_SCOPES as string[],
      resourceName: 'TREK MCP',
    });
    return _sdkMetaRouter;
  }

  // Path-aware gate: only /.well-known/* returns 404 when disabled; other paths pass through
  // so static files and SPA routes are unaffected when MCP is off.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const isMetadataPath =
        req.path === '/.well-known/oauth-authorization-server' ||
        req.path === '/.well-known/openid-configuration' ||
        req.path.startsWith('/.well-known/oauth-protected-resource');
    if (isMetadataPath && !isAddonEnabled(ADDON_IDS.MCP)) return res.status(404).end();
    getMetaRouter()(req, res, next);
  });

  // ChatGPT (and other OIDC-first clients) bootstrap OAuth discovery via
  // /.well-known/openid-configuration. Serve the AS metadata plus the OIDC
  // userinfo_endpoint so ChatGPT can fetch the authenticated user's email
  // for authorization domain claiming.
  app.get('/.well-known/openid-configuration', (_req: Request, res: Response) => {
    const meta = getOAuthMetadata();
    res.json({
      ...meta,
      userinfo_endpoint: `${meta.issuer}/oauth/userinfo`,
    });
  });

  // RFC 9728 flat well-known URL — served alongside the path-based form the SDK already provides.
  // Clients like ChatGPT probe /.well-known/oauth-protected-resource (no path suffix) on every
  // fresh discovery. Without this, they get 404, fall back to the issuer URL as the resource
  // parameter, and the authorize handler rejects them with invalid_target — showing the user
  // the TREK home page instead of the consent form.
  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(404).end();
    const meta = getOAuthMetadata();
    res.json({
      resource:                 `${meta.issuer}/mcp`,
      authorization_servers:    [meta.issuer],
      bearer_methods_supported: ['header'],
      scopes_supported:         ALL_SCOPES,
      resource_name:            'TREK MCP',
    });
  });

  // SDK authorize handler: validates OAuth params, calls provider.authorize() which redirects
  // to the SPA consent page at /oauth/consent
  app.use('/oauth/authorize', mcpAddonGate, authorizationHandler({ provider: trekOAuthProvider }));

  // SDK DCR handler: accepts registrations without scope (fixes issue #959 bug 2)
  app.use('/oauth/register', mcpAddonGate, clientRegistrationHandler({ clientsStore: trekClientsStore }));

  // Token and revoke keep TREK's own handlers (timing-safe hash comparison not supported by SDK clientAuth)
  // oauthPublicRouter has per-route isAddonEnabled checks; no blanket gate needed here
  app.use('/', oauthPublicRouter);

  // MCP endpoint
  app.post('/mcp', mcpHandler);
  app.get('/mcp', mcpHandler);
  app.delete('/mcp', mcpHandler);

  // Return 404 JSON for any /.well-known/* path the SDK metadata router doesn't handle.
  // Without this, the SPA catch-all serves HTML — clients probing
  // /.well-known/openid-configuration or the RFC 8414 path-suffixed AS metadata URL
  // receive a 200 HTML response they can't parse as JSON, causing "does not implement OAuth".
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/.well-known/')) return res.status(404).json({ error: 'not_found' });
    next();
  });

  // Helmet's COOP: same-origin isolates the consent popup from its cross-origin opener (ChatGPT etc.), making window.opener null and breaking the OAuth flow.
  app.use('/oauth/consent', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    next();
  });

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
    const status = err.statusCode || err.status || 500;
    // Expose the message for client errors (4xx); keep 'Internal server error' for 5xx.
    const message = status < 500 ? err.message : 'Internal server error';
    res.status(status).json({ error: message });
  });

  return app;
}