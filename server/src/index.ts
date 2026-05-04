import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from './app';

// Create upload and data directories on startup
const uploadsDir = path.join(__dirname, '../uploads');
const photosDir = path.join(uploadsDir, 'photos');
const filesDir = path.join(uploadsDir, 'files');
const coversDir = path.join(uploadsDir, 'covers');
const avatarsDir = path.join(uploadsDir, 'avatars');
const backupsDir = path.join(__dirname, '../data/backups');
const tmpDir = path.join(__dirname, '../data/tmp');

[uploadsDir, photosDir, filesDir, coversDir, avatarsDir, backupsDir, tmpDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = createApp();

import * as scheduler from './scheduler';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST;
const APP_VERSION: string = process.env.APP_VERSION || (require('../package.json') as { version: string }).version;

const onListen = () => {
  const { logInfo: sLogInfo, logWarn: sLogWarn } = require('./services/auditLog');
  const LOG_LVL = (process.env.LOG_LEVEL || 'info').toLowerCase();
  const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const origins = process.env.ALLOWED_ORIGINS || '(same-origin)';
  const banner = [
    '──────────────────────────────────────',
    '  TREK API started',
    `  Version      ${APP_VERSION}`,
    ...(HOST ? [`  Host:        ${HOST}`] : []),
    `  Port:        ${PORT}`,
    `  Environment: ${process.env.NODE_ENV?.toLowerCase() || 'development'}`,
    `  Timezone:    ${tz}`,
    `  Origins:     ${origins}`,
    `  Log level:   ${LOG_LVL}`,
    `  Log file:    /app/data/logs/trek.log`,
    `  PID:         ${process.pid}`,
    `  User:        uid=${process.getuid?.()} gid=${process.getgid?.()}`,
    '──────────────────────────────────────',
  ];
  banner.forEach(l => console.log(l));
  if (process.env.DEMO_MODE?.toLowerCase() === 'true') sLogInfo('Demo mode: ENABLED');
  if (process.env.DEMO_MODE?.toLowerCase() === 'true' && process.env.NODE_ENV?.toLowerCase() === 'production') {
    sLogWarn('SECURITY WARNING: DEMO_MODE is enabled in production!');
  }
  scheduler.start();
  scheduler.startTripReminders();
  scheduler.startTodoReminders();
  scheduler.startVersionCheck();
  scheduler.startDemoReset();
  scheduler.startIdempotencyCleanup();
  scheduler.startTrekPhotoCacheCleanup();
  const { startTokenCleanup } = require('./services/ephemeralTokens');
  startTokenCleanup();
  import('./websocket').then(({ setupWebSocket }) => {
    setupWebSocket(server);
  });
};

const server = HOST
  ? app.listen(PORT, HOST, onListen)
  : app.listen(PORT, onListen);

// Graceful shutdown
function shutdown(signal: string): void {
  const { logInfo: sLogInfo, logError: sLogError } = require('./services/auditLog');
  const { closeMcpSessions } = require('./mcp');
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
