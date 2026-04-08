import 'dotenv/config';
import { createApp } from './app';
import * as scheduler from './scheduler';

const app = createApp();

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`TREK API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
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
