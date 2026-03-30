import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createTables } from '../../db/schema';
import { runMigrations } from '../../db/migrations';

const TEST_SECRET = 'integration-test-jwt-secret';

// Mock config
vi.mock('../../config', () => ({
  JWT_SECRET: 'integration-test-jwt-secret',
}));

// We'll create a fresh in-memory DB for each test and inject it
let testDb: Database.Database;

vi.mock('../../db/database', () => {
  return {
    db: new Proxy({} as Database.Database, {
      get(_, prop: string | symbol) {
        // @ts-ignore - testDb is assigned in beforeEach
        const val = (testDb as any)[prop];
        return typeof val === 'function' ? val.bind(testDb) : val;
      },
    }),
    canAccessTrip: vi.fn(),
    isOwner: vi.fn(),
  };
});

// Suppress console output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

// Must import AFTER mocks are set up
import express from 'express';
import authRoutes from '../../routes/auth';

// Each test gets a unique fake IP so the in-memory rate limiter doesn't bleed across tests
let testIpCounter = 0;
function nextIp() {
  testIpCounter++;
  return `10.0.0.${testIpCounter}`;
}

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // trust X-Forwarded-For for unique test IPs
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  return app;
}

function request(app: express.Express) {
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const fakeIp = nextIp();

  return {
    get: (path: string, headers: Record<string, string> = {}) =>
      fetch(`${baseUrl}${path}`, {
        headers: { 'X-Forwarded-For': fakeIp, ...headers },
      }).then(async (r) => ({
        status: r.status,
        body: await r.json().catch(() => null),
      })),
    post: (path: string, body: object, headers: Record<string, string> = {}) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': fakeIp, ...headers },
        body: JSON.stringify(body),
      }).then(async (r) => ({
        status: r.status,
        body: await r.json().catch(() => null),
      })),
    put: (path: string, body: object, headers: Record<string, string> = {}) =>
      fetch(`${baseUrl}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': fakeIp, ...headers },
        body: JSON.stringify(body),
      }).then(async (r) => ({
        status: r.status,
        body: await r.json().catch(() => null),
      })),
    delete: (path: string, headers: Record<string, string> = {}) =>
      fetch(`${baseUrl}${path}`, {
        method: 'DELETE',
        headers: { 'X-Forwarded-For': fakeIp, ...headers },
      }).then(async (r) => ({
        status: r.status,
        body: await r.json().catch(() => null),
      })),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('Auth Routes - Registration', () => {
  let app: express.Express;
  let http: ReturnType<typeof request>;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec('PRAGMA foreign_keys = ON');
    createTables(testDb);
    runMigrations(testDb);
    app = createApp();
    http = request(app);
  });

  afterEach(async () => {
    await http.close();
    testDb.close();
  });

  it('registers first user as admin', async () => {
    const res = await http.post('/api/auth/register', {
      username: 'admin',
      email: 'admin@test.com',
      password: 'Password1',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user.username).toBe('admin');
    expect(res.body.token).toBeDefined();
  });

  it('registers second user as regular user', async () => {
    // Create first user (admin)
    await http.post('/api/auth/register', {
      username: 'admin',
      email: 'admin@test.com',
      password: 'Password1',
    });
    const res = await http.post('/api/auth/register', {
      username: 'user2',
      email: 'user2@test.com',
      password: 'Password1',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('user');
  });

  it('rejects registration without required fields', async () => {
    const res = await http.post('/api/auth/register', {
      username: 'test',
      email: 'test@test.com',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects short password', async () => {
    const res = await http.post('/api/auth/register', {
      username: 'test',
      email: 'test@test.com',
      password: 'Ab1',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/);
  });

  it('rejects password without uppercase', async () => {
    const res = await http.post('/api/auth/register', {
      username: 'test',
      email: 'test@test.com',
      password: 'password1',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uppercase/);
  });

  it('rejects password without lowercase', async () => {
    const res = await http.post('/api/auth/register', {
      username: 'test',
      email: 'test@test.com',
      password: 'PASSWORD1',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lowercase/);
  });

  it('rejects password without number', async () => {
    const res = await http.post('/api/auth/register', {
      username: 'test',
      email: 'test@test.com',
      password: 'Passwordx',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/number/);
  });

  it('rejects invalid email format', async () => {
    const res = await http.post('/api/auth/register', {
      username: 'test',
      email: 'not-an-email',
      password: 'Password1',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('rejects duplicate email (case-insensitive)', async () => {
    await http.post('/api/auth/register', {
      username: 'user1',
      email: 'test@test.com',
      password: 'Password1',
    });
    const res = await http.post('/api/auth/register', {
      username: 'user2',
      email: 'TEST@test.com',
      password: 'Password1',
    });
    expect(res.status).toBe(409);
  });

  it('rejects duplicate username (case-insensitive)', async () => {
    await http.post('/api/auth/register', {
      username: 'Alice',
      email: 'alice@test.com',
      password: 'Password1',
    });
    const res = await http.post('/api/auth/register', {
      username: 'alice',
      email: 'different@test.com',
      password: 'Password1',
    });
    expect(res.status).toBe(409);
  });

  it('does not leak whether email or username caused conflict', async () => {
    await http.post('/api/auth/register', {
      username: 'taken',
      email: 'taken@test.com',
      password: 'Password1',
    });
    const res = await http.post('/api/auth/register', {
      username: 'taken',
      email: 'other@test.com',
      password: 'Password1',
    });
    // Should NOT say "email already exists" or "username already exists"
    expect(res.body.error).not.toMatch(/email/i);
    expect(res.body.error).not.toMatch(/username/i);
    expect(res.body.error).toMatch(/different credentials/i);
  });

  it('returns a valid JWT on successful registration', async () => {
    const res = await http.post('/api/auth/register', {
      username: 'newuser',
      email: 'new@test.com',
      password: 'Password1',
    });
    expect(res.status).toBe(201);
    const decoded = jwt.verify(res.body.token, TEST_SECRET) as any;
    expect(decoded.id).toBeDefined();
    expect(decoded.exp).toBeDefined();
  });

  it('does not return password_hash in response', async () => {
    const res = await http.post('/api/auth/register', {
      username: 'newuser',
      email: 'new@test.com',
      password: 'Password1',
    });
    expect(res.body.user.password_hash).toBeUndefined();
    expect(res.body.user.mfa_secret).toBeUndefined();
  });
});

describe('Auth Routes - Login', () => {
  let app: express.Express;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    testDb = new Database(':memory:');
    testDb.exec('PRAGMA foreign_keys = ON');
    createTables(testDb);
    runMigrations(testDb);
    app = createApp();
    http = request(app);

    // Seed a user
    const hash = bcrypt.hashSync('Password1', 12);
    testDb.prepare(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run('alice', 'alice@test.com', hash, 'user');
  });

  afterEach(async () => {
    await http.close();
    testDb.close();
  });

  it('logs in with valid credentials', async () => {
    const res = await http.post('/api/auth/login', {
      email: 'alice@test.com',
      password: 'Password1',
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe('alice@test.com');
  });

  it('login is case-insensitive on email', async () => {
    const res = await http.post('/api/auth/login', {
      email: 'ALICE@test.com',
      password: 'Password1',
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it('rejects wrong password', async () => {
    const res = await http.post('/api/auth/login', {
      email: 'alice@test.com',
      password: 'WrongPass1',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password');
  });

  it('rejects non-existent email', async () => {
    const res = await http.post('/api/auth/login', {
      email: 'nobody@test.com',
      password: 'Password1',
    });
    expect(res.status).toBe(401);
    // Same error message for both cases (no user enumeration)
    expect(res.body.error).toBe('Invalid email or password');
  });

  it('rejects login with missing fields', async () => {
    const res = await http.post('/api/auth/login', { email: 'alice@test.com' });
    expect(res.status).toBe(400);
  });

  it('does not return sensitive fields on login', async () => {
    const res = await http.post('/api/auth/login', {
      email: 'alice@test.com',
      password: 'Password1',
    });
    expect(res.body.user.password_hash).toBeUndefined();
    expect(res.body.user.mfa_secret).toBeUndefined();
    expect(res.body.user.maps_api_key).toBeUndefined();
    expect(res.body.user.unsplash_api_key).toBeUndefined();
    expect(res.body.user.openweather_api_key).toBeUndefined();
  });

  it('updates last_login on successful login', async () => {
    await http.post('/api/auth/login', {
      email: 'alice@test.com',
      password: 'Password1',
    });
    const user = testDb.prepare('SELECT last_login FROM users WHERE email = ?').get('alice@test.com') as any;
    expect(user.last_login).not.toBeNull();
  });
});

describe('Auth Routes - GET /me', () => {
  let app: express.Express;
  let http: ReturnType<typeof request>;
  let token: string;

  beforeEach(async () => {
    testDb = new Database(':memory:');
    testDb.exec('PRAGMA foreign_keys = ON');
    createTables(testDb);
    runMigrations(testDb);
    app = createApp();
    http = request(app);

    const hash = bcrypt.hashSync('Password1', 12);
    const result = testDb.prepare(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run('alice', 'alice@test.com', hash, 'user');
    token = jwt.sign({ id: result.lastInsertRowid }, TEST_SECRET, { expiresIn: '1h' });
  });

  afterEach(async () => {
    await http.close();
    testDb.close();
  });

  it('returns current user profile', async () => {
    const res = await http.get('/api/auth/me', {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('alice');
    expect(res.body.user.email).toBe('alice@test.com');
  });

  it('returns 401 without token', async () => {
    const res = await http.get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 with expired token', async () => {
    const expiredToken = jwt.sign({ id: 1 }, TEST_SECRET, { expiresIn: '0s' });
    // Small delay to ensure expiration
    await new Promise((r) => setTimeout(r, 50));
    const res = await http.get('/api/auth/me', {
      Authorization: `Bearer ${expiredToken}`,
    });
    expect(res.status).toBe(401);
  });
});

describe('Auth Routes - Password Change', () => {
  let app: express.Express;
  let http: ReturnType<typeof request>;
  let token: string;

  beforeEach(async () => {
    testDb = new Database(':memory:');
    testDb.exec('PRAGMA foreign_keys = ON');
    createTables(testDb);
    runMigrations(testDb);
    app = createApp();
    http = request(app);

    const hash = bcrypt.hashSync('Password1', 12);
    const result = testDb.prepare(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run('alice', 'alice@test.com', hash, 'user');
    token = jwt.sign({ id: result.lastInsertRowid }, TEST_SECRET, { expiresIn: '1h' });
  });

  afterEach(async () => {
    await http.close();
    testDb.close();
  });

  it('changes password with valid current password', async () => {
    const res = await http.put(
      '/api/auth/me/password',
      { current_password: 'Password1', new_password: 'NewPassword2' },
      { Authorization: `Bearer ${token}` }
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify new password works
    const loginRes = await http.post('/api/auth/login', {
      email: 'alice@test.com',
      password: 'NewPassword2',
    });
    expect(loginRes.status).toBe(200);
  });

  it('rejects password change with wrong current password', async () => {
    const res = await http.put(
      '/api/auth/me/password',
      { current_password: 'WrongPass1', new_password: 'NewPassword2' },
      { Authorization: `Bearer ${token}` }
    );
    expect(res.status).toBe(401);
  });

  it('rejects weak new password', async () => {
    const res = await http.put(
      '/api/auth/me/password',
      { current_password: 'Password1', new_password: 'weak' },
      { Authorization: `Bearer ${token}` }
    );
    expect(res.status).toBe(400);
  });

  it('rejects new password without complexity requirements', async () => {
    const res = await http.put(
      '/api/auth/me/password',
      { current_password: 'Password1', new_password: 'alllowercase1' },
      { Authorization: `Bearer ${token}` }
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uppercase/);
  });
});

describe('Auth Routes - Account Deletion', () => {
  let app: express.Express;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    testDb = new Database(':memory:');
    testDb.exec('PRAGMA foreign_keys = ON');
    createTables(testDb);
    runMigrations(testDb);
    app = createApp();
    http = request(app);
  });

  afterEach(async () => {
    await http.close();
    testDb.close();
  });

  it('prevents deletion of last admin account', async () => {
    const hash = bcrypt.hashSync('Password1', 12);
    const result = testDb.prepare(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run('admin', 'admin@test.com', hash, 'admin');
    const token = jwt.sign({ id: result.lastInsertRowid }, TEST_SECRET, { expiresIn: '1h' });

    const res = await http.delete('/api/auth/me', {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last admin/i);
  });

  it('allows deletion of non-admin user', async () => {
    const hash = bcrypt.hashSync('Password1', 12);
    const result = testDb.prepare(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run('user1', 'user1@test.com', hash, 'user');
    const token = jwt.sign({ id: result.lastInsertRowid }, TEST_SECRET, { expiresIn: '1h' });

    const res = await http.delete('/api/auth/me', {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify user is gone
    const user = testDb.prepare('SELECT id FROM users WHERE email = ?').get('user1@test.com');
    expect(user).toBeUndefined();
  });

  it('allows admin deletion when other admins exist', async () => {
    const hash = bcrypt.hashSync('Password1', 12);
    testDb.prepare(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run('admin1', 'admin1@test.com', hash, 'admin');
    const result = testDb.prepare(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run('admin2', 'admin2@test.com', hash, 'admin');
    const token = jwt.sign({ id: result.lastInsertRowid }, TEST_SECRET, { expiresIn: '1h' });

    const res = await http.delete('/api/auth/me', {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
  });
});

describe('Auth Routes - MFA Login Flow', () => {
  let app: express.Express;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    testDb = new Database(':memory:');
    testDb.exec('PRAGMA foreign_keys = ON');
    createTables(testDb);
    runMigrations(testDb);
    app = createApp();
    http = request(app);

    // Create user with MFA enabled
    const hash = bcrypt.hashSync('Password1', 12);
    testDb.prepare(
      'INSERT INTO users (username, email, password_hash, role, mfa_enabled, mfa_secret) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('mfauser', 'mfa@test.com', hash, 'user', 1, 'encrypted-secret');
  });

  afterEach(async () => {
    await http.close();
    testDb.close();
  });

  it('returns mfa_required when MFA is enabled', async () => {
    const res = await http.post('/api/auth/login', {
      email: 'mfa@test.com',
      password: 'Password1',
    });
    expect(res.status).toBe(200);
    expect(res.body.mfa_required).toBe(true);
    expect(res.body.mfa_token).toBeDefined();
    // Should NOT return a full auth token
    expect(res.body.token).toBeUndefined();
    expect(res.body.user).toBeUndefined();
  });

  it('mfa_token has short expiry and purpose claim', async () => {
    const res = await http.post('/api/auth/login', {
      email: 'mfa@test.com',
      password: 'Password1',
    });
    const decoded = jwt.verify(res.body.mfa_token, TEST_SECRET) as any;
    expect(decoded.purpose).toBe('mfa_login');
    // Should expire in 5 minutes (300 seconds)
    const ttl = decoded.exp - decoded.iat;
    expect(ttl).toBe(300);
  });
});
