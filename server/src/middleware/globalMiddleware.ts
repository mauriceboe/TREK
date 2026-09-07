import express, { Request, Response, NextFunction } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { readEnv, type AppEnv } from '../app-config';
import { logDebug, logWarn, logError } from '../nest/audit/audit-log.logger';

/**
 * Field names redacted from request-log query/body dumps (case-insensitive —
 * lookup lowercases the key first). `secretaccesskey` covers the S3 storage
 * backend's secret field (storage-admin PUT bodies land in the same debug
 * log line as any other request body).
 *
 * Exported (module-level, not per-request) so it can be unit-tested directly
 * without threading LOG_LEVEL through the real logger pipeline.
 */
export const SENSITIVE_KEYS = new Set([
  'password',
  'new_password',
  'current_password',
  'token',
  'jwt',
  'authorization',
  'cookie',
  'client_secret',
  'mfa_token',
  'code',
  'smtp_pass',
  'secretaccesskey',
]);

/**
 * Suffixes that make a field sensitive whatever its prefix. Matched on the end of
 * the key, not anywhere in it: `accessKeyId` is an identifier and stays readable,
 * while `refresh_token`, `code_verifier`, `mapbox_access_token` and the whole
 * `*_api_key` family are secrets nobody needs in a debug log.
 */
const SENSITIVE_SUFFIXES = ['_token', '_key', '_secret', '_password', '_pass', '_verifier'];

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_KEYS.has(lower) || SENSITIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** Deep-redacts every key in `SENSITIVE_KEYS` (case-insensitive) from a request-log value. */
export function redact(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return (value as unknown[]).map(redact);
  const entries = value as Record<string, unknown>;
  // PUT /api/settings names the setting instead of using it as the field:
  // {key: 'carto_api_key', value: '<secret>'}. Neither field name is sensitive
  // on its own, so without this the secret goes into the debug log in cleartext.
  const namedSecret = typeof entries.key === 'string' && isSensitiveName(entries.key);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entries)) {
    out[k] = isSensitiveName(k) || (namedSecret && k === 'value') ? '[REDACTED]' : redact(v);
  }
  return out;
}

/**
 * The global request pipeline shared by the legacy Express app and the NestJS
 * instance. Both mount the *exact same* config so a request hitting a migrated
 * Nest route is protected identically to one hitting the legacy fallback
 * (helmet/CSP, CORS, HSTS, forced-HTTPS, the global MFA policy and request
 * logging). Keeping it in one place is what makes the strangler dispatch
 * behaviourally transparent — and is the prerequisite for retiring Express,
 * since the Nest instance must carry the whole shell on its own.
 *
 * Body parsing is NOT here: the Nest instance does it, with the limit pinned in
 * bootstrap.ts. The flag that used to switch a second parser on had exactly one
 * caller, which passed false.
 */
export function applyGlobalMiddleware(
  app: express.Application,
  opts: { http?: AppEnv['http'] } = {},
): void {
  // The whole pipeline is configured at APPLY time (the per-request closures
  // capture these values), so a snapshot is the correct semantic. bootstrap
  // threads in the DI-loaded httpConfig; direct callers fall back to an
  // apply-time readEnv() — same values, same freeze point.
  const { http = readEnv().http } = opts;
  const { nodeEnv, isProduction } = readEnv().app;

  // Trust first proxy (nginx/Docker) for correct req.ip
  if (isProduction || http.trustProxyRaw) {
    app.set('trust proxy', http.trustProxy);
  }

  // Compress responses (gzip via Accept-Encoding). The Atlas admin-0 country
  // GeoJSON is ~30 MB uncompressed, which stalls/aborts (~8s → net::ERR_FAILED)
  // behind reverse proxies and Cloudflare Tunnel (#1254); gzip brings it to ~4 MB.
  // SSE responses (the /mcp StreamableHTTP transport) must NOT be buffered, so
  // they are excluded explicitly.
  app.use(
    compression({
      filter: (req, res) => {
        const type = res.getHeader('Content-Type');
        if (typeof type === 'string' && type.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );

  const allowedOrigins = http.corsOrigins;

  let corsOrigin: cors.CorsOptions['origin'];
  if (allowedOrigins) {
    corsOrigin = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error('Not allowed by CORS'));
    };
  } else if (isProduction) {
    corsOrigin = false;
  } else {
    corsOrigin = true;
  }

  const shouldForceHttps = http.forceHttps;
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
  // nodeEnv compared case-sensitively here on purpose (legacy parity — the
  // trust-proxy/CORS checks above are the case-insensitive ones).
  const hstsActive = shouldForceHttps || nodeEnv === 'production';
  const hstsIncludeSubdomains = http.hstsIncludeSubdomains;

  // RFC 8414 / RFC 9728 / RFC 7591: discovery docs and DCR are world-readable/writable.
  // /mcp needs open CORS so external MCP clients (ChatGPT, Claude.ai, Inspector) can call it
  // with Bearer tokens from any origin. /oauth/register and /oauth/authorize need it for
  // browser-based DCR/authorization preflights — the global cors({ origin: false }) would
  // answer OPTIONS without Access-Control-Allow-Origin before the SDK's own cors() runs.
  // All /.well-known/* paths get open CORS so clients probing openid-configuration or the
  // RFC 8414 path-suffixed AS metadata form don't get CORS-blocked (they get 404 JSON instead).
  //
  // `exposedHeaders` is load-bearing, not cosmetic. Without Access-Control-Expose-Headers the
  // Fetch spec forbids a browser-context client (Claude Desktop connectors, Claude.ai, MCP
  // Inspector) from *reading* Mcp-Session-Id off the initialize response — so it can never echo
  // the header back, every request looks like a fresh initialize, and the server mints a new
  // session per tool call until the per-user cap wedges the connection. Same reasoning for
  // WWW-Authenticate, which carries the RFC 9728 resource-metadata challenge that drives
  // OAuth discovery.
  app.use(
    (req: Request, _res: Response, next: NextFunction) => {
      if (
        req.path.startsWith('/.well-known/') ||
        req.path === '/oauth/register' ||
        req.path === '/oauth/authorize' ||
        req.path === '/oauth/userinfo' ||
        req.path === '/mcp'
      ) {
        cors({
          origin: '*',
          credentials: false,
          exposedHeaders: ['Mcp-Session-Id', 'MCP-Protocol-Version', 'WWW-Authenticate'],
        })(req, _res, next);
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
        // 'unsafe-eval' is load-bearing, not leftover: heic-to's libheif build
        // initialises embind through new Function(), and that is what converts
        // an iPhone .heic the moment somebody picks one. 'wasm-unsafe-eval'
        // alone was tried first and was not enough (93b51a0b). The package
        // ships a CSP-safe entry point at heic-to/csp; dropping this directive
        // means switching client/src/utils/convertHeic.ts over to it and
        // verifying a real .heic upload in a browser, not just deleting the
        // string here.
        scriptSrc: ["'self'", "'wasm-unsafe-eval'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: [
          "'self'", "ws:", "wss:",
          "https://nominatim.openstreetmap.org", "https://overpass-api.de",
          "https://places.googleapis.com", "https://api.openweathermap.org",
          "https://en.wikipedia.org", "https://commons.wikimedia.org",
          // Both forms here too: CARTO documents the apex host on its key page,
          // so that is the template users paste in, and the {s} sharded form is
          // what TREK ships (#2054).
          "https://basemaps.cartocdn.com", "https://*.basemaps.cartocdn.com",
          // Both forms: a CSP wildcard host never matches the apex, and OSM
          // serves everything from the bare tile.openstreetmap.org since it
          // retired the a/b/c/d shards (#1733). The sharded hosts stay listed
          // for tile templates users saved before that.
          "https://tile.openstreetmap.org", "https://*.tile.openstreetmap.org",
          // The other two raster presets TREK ships. `mode: 'no-cors'` relaxes
          // CORS, not CSP, so without these the tile prefetch is refused in the
          // document and never reaches the Service Worker that would cache it
          // (#2180). routing.openstreetmap.de below is a different host.
          "https://tile.openstreetmap.de", "https://tiles.stadiamaps.com",
          // Amap's raster tiles, for an install whose users are in China. Here
          // for the same reason as the two above: imgSrc already allows https:,
          // so the tiles DRAW without this, but the offline tile prefetch is a
          // fetch() and is refused in the document without a connectSrc entry
          // (#2180). Road and satellite sit on different hosts, and the wildcard
          // covers the shard families the same tiles are also served from — a
          // CSP wildcard never matches the apex, so both forms are listed.
          "https://webrd01.is.autonavi.com", "https://webst01.is.autonavi.com",
          "https://*.is.autonavi.com",
          "https://unpkg.com", "https://open-meteo.com", "https://api.open-meteo.com",
          "https://geocoding-api.open-meteo.com", "https://api.frankfurter.dev",
          "https://router.project-osrm.org/route/v1/", "https://routing.openstreetmap.de/",
          "https://api.mapbox.com", "https://*.tiles.mapbox.com", "https://events.mapbox.com",
          "https://tiles.openfreemap.org"
        ],
        workerSrc: ["'self'", "blob:"],
        childSrc: ["'self'", "blob:"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        // 'self' so same-origin file previews can embed PDFs via <object>/<embed>
        // (Firefox/Chrome enforce object-src; 'none' broke inline PDF previews there).
        objectSrc: ["'self'"],
        // 'self' so the app can embed same-origin, sandboxed plugin frames
        // (/plugin-frame/*). Those frames are sandboxed WITHOUT allow-same-origin,
        // so they run at an opaque origin and get their own locked-down CSP.
        frameSrc: ["'self'"],
        frameAncestors: ["'self'"],
        // Restrict <form> submission targets (form-action has no default-src
        // fallback, so it must be set explicitly).
        formAction: ["'self'"],
        upgradeInsecureRequests: shouldForceHttps ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts: hstsActive ? { maxAge: 31536000, includeSubDomains: hstsIncludeSubdomains } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));

  // The instance's own hostname, when the operator configured one. The redirect
  // below is a 301, so echoing a client-supplied Host header would let a stranger
  // park a foreign origin in a visitor's cache. Falls back to the request Host for
  // instances that never set APP_URL, which is what it always did.
  const configuredHost = (() => {
    const url = readEnv().app.appUrl;
    try {
      return url ? new URL(url).host : null;
    } catch {
      return null;
    }
  })();

  if (shouldForceHttps) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path === '/api/health') return next();
      if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
      res.redirect(301, 'https://' + (configuredHost ?? req.headers.host) + req.url);
    });
  }

  app.use(cookieParser());

  // Request logging with sensitive field redaction (SENSITIVE_KEYS/redact above)
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
