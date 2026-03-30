import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

const TEST_JWT_SECRET = 'test-secret-for-auth-middleware';

// Mock config and database before importing auth middleware
vi.mock('../../config', () => ({
  JWT_SECRET: 'test-secret-for-auth-middleware',
}));

const mockDbPrepare = vi.fn();
vi.mock('../../db/database', () => ({
  db: {
    prepare: (...args: unknown[]) => mockDbPrepare(...args),
  },
}));

import { authenticate, optionalAuth, adminOnly, demoUploadBlock } from '../../middleware/auth';

function mockRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function signToken(payload: object, secret = TEST_JWT_SECRET) {
  return jwt.sign(payload, secret, { expiresIn: '1h' });
}

describe('authenticate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when no authorization header', () => {
    const req = { headers: {} } as Request;
    const res = mockRes();
    const next = vi.fn();
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Access token required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when authorization header has no token', () => {
    const req = { headers: { authorization: 'Bearer ' } } as Request;
    const res = mockRes();
    const next = vi.fn();
    authenticate(req, res, next);
    // 'Bearer '.split(' ')[1] is '', which is falsy
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is invalid', () => {
    const req = { headers: { authorization: 'Bearer bad-token' } } as Request;
    const res = mockRes();
    const next = vi.fn();
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is signed with wrong secret', () => {
    const token = signToken({ id: 1 }, 'wrong-secret');
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = mockRes();
    const next = vi.fn();
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when user not found in database', () => {
    const token = signToken({ id: 999 });
    mockDbPrepare.mockReturnValue({ get: () => undefined });
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = mockRes();
    const next = vi.fn();
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'User not found' });
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches user and calls next on valid token', () => {
    const user = { id: 1, username: 'alice', email: 'alice@test.com', role: 'user' };
    const token = signToken({ id: 1 });
    mockDbPrepare.mockReturnValue({ get: () => user });
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = mockRes();
    const next = vi.fn();
    authenticate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect((req as any).user).toEqual(user);
  });
});

describe('optionalAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets user to null and calls next when no token', () => {
    const req = { headers: {} } as Request;
    const res = mockRes();
    const next = vi.fn();
    optionalAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect((req as any).user).toBeNull();
  });

  it('sets user to null on invalid token (does not 401)', () => {
    const req = { headers: { authorization: 'Bearer bad-token' } } as Request;
    const res = mockRes();
    const next = vi.fn();
    optionalAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect((req as any).user).toBeNull();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('attaches user on valid token', () => {
    const user = { id: 1, username: 'alice', email: 'alice@test.com', role: 'user' };
    const token = signToken({ id: 1 });
    mockDbPrepare.mockReturnValue({ get: () => user });
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = mockRes();
    const next = vi.fn();
    optionalAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect((req as any).user).toEqual(user);
  });

  it('sets user to null when user not found in db', () => {
    const token = signToken({ id: 999 });
    mockDbPrepare.mockReturnValue({ get: () => undefined });
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = mockRes();
    const next = vi.fn();
    optionalAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect((req as any).user).toBeNull();
  });
});

describe('adminOnly', () => {
  it('returns 403 when user is not admin', () => {
    const req = { user: { id: 1, username: 'alice', email: 'a@b.com', role: 'user' } } as any;
    const res = mockRes();
    const next = vi.fn();
    adminOnly(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Admin access required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when user is missing', () => {
    const req = {} as any;
    const res = mockRes();
    const next = vi.fn();
    adminOnly(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when user is admin', () => {
    const req = { user: { id: 1, username: 'admin', email: 'a@b.com', role: 'admin' } } as any;
    const res = mockRes();
    const next = vi.fn();
    adminOnly(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('demoUploadBlock', () => {
  const originalEnv = process.env.DEMO_MODE;

  beforeEach(() => {
    delete process.env.DEMO_MODE;
  });

  it('calls next when not in demo mode', () => {
    const req = { user: { email: 'demo@nomad.app' } } as any;
    const res = mockRes();
    const next = vi.fn();
    demoUploadBlock(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('blocks demo user uploads in demo mode', () => {
    process.env.DEMO_MODE = 'true';
    const req = { user: { email: 'demo@nomad.app' } } as any;
    const res = mockRes();
    const next = vi.fn();
    demoUploadBlock(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows non-demo user uploads in demo mode', () => {
    process.env.DEMO_MODE = 'true';
    const req = { user: { email: 'alice@example.com' } } as any;
    const res = mockRes();
    const next = vi.fn();
    demoUploadBlock(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DEMO_MODE = originalEnv;
    } else {
      delete process.env.DEMO_MODE;
    }
  });
});
