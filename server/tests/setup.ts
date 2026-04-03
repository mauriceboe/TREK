// Global test setup — runs before every test file.
// Environment variables must be set before any module import so that
// config.ts, database.ts, etc. pick them up at import time.

// Fixed encryption key (64 hex chars = 32 bytes) for at-rest crypto in tests
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2';
process.env.NODE_ENV = 'test';
process.env.COOKIE_SECURE = 'false';
process.env.LOG_LEVEL = 'error'; // suppress info/debug logs in test output
