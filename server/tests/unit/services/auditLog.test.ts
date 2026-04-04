import { describe, it, expect, vi } from 'vitest';

// Prevent file I/O side effects at module load time
vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => ({ size: 0 })),
    appendFileSync: vi.fn(),
    renameSync: vi.fn(),
  },
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => ({ size: 0 })),
  appendFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('../../../src/db/database', () => ({
  db: { prepare: () => ({ get: vi.fn(), run: vi.fn() }) },
}));

import { getClientIp } from '../../../src/services/auditLog';
import type { Request } from 'express';

function makeReq(options: {
  xff?: string | string[];
  remoteAddress?: string;
} = {}): Request {
  return {
    headers: {
      ...(options.xff !== undefined ? { 'x-forwarded-for': options.xff } : {}),
    },
    socket: { remoteAddress: options.remoteAddress ?? undefined },
  } as unknown as Request;
}

describe('getClientIp', () => {
  it('returns first IP from comma-separated X-Forwarded-For string', () => {
    expect(getClientIp(makeReq({ xff: '1.2.3.4, 5.6.7.8, 9.10.11.12' }))).toBe('1.2.3.4');
  });

  it('returns single IP when X-Forwarded-For has no comma', () => {
    expect(getClientIp(makeReq({ xff: '10.0.0.1' }))).toBe('10.0.0.1');
  });

  it('returns first element when X-Forwarded-For is an array', () => {
    expect(getClientIp(makeReq({ xff: ['203.0.113.1', '10.0.0.1'] }))).toBe('203.0.113.1');
  });

  it('trims whitespace from extracted IP', () => {
    expect(getClientIp(makeReq({ xff: '  192.168.1.1  , 10.0.0.1' }))).toBe('192.168.1.1');
  });

  it('falls back to req.socket.remoteAddress when no X-Forwarded-For', () => {
    expect(getClientIp(makeReq({ remoteAddress: '172.16.0.1' }))).toBe('172.16.0.1');
  });

  it('returns null when no forwarded header and no socket address', () => {
    expect(getClientIp(makeReq({}))).toBeNull();
  });

  it('returns null for empty string X-Forwarded-For', () => {
    const req = {
      headers: { 'x-forwarded-for': '' },
      socket: { remoteAddress: undefined },
    } as unknown as Request;
    expect(getClientIp(req)).toBeNull();
  });
});
