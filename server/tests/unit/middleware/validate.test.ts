import { describe, it, expect, vi } from 'vitest';
import { maxLength, validateStringLengths } from '../../../src/middleware/validate';
import type { Request, Response, NextFunction } from 'express';

function makeReq(body: Record<string, unknown> = {}): Request {
  return { body } as Request;
}

function makeRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status } as unknown as Response;
  return { res, status, json };
}

// ── maxLength ────────────────────────────────────────────────────────────────

describe('maxLength', () => {
  it('calls next() when field is absent from body', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    maxLength('name', 10)(makeReq({}), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next() when field is not a string (number)', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    maxLength('count', 5)(makeReq({ count: 999 }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next() when string length is within limit', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    maxLength('name', 10)(makeReq({ name: 'hello' }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next() when string length equals max exactly', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    maxLength('name', 5)(makeReq({ name: 'hello' }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 400 when field exceeds max', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res, status, json } = makeRes();
    maxLength('name', 4)(makeReq({ name: 'hello' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('name') }));
  });

  it('error message includes field name and max length', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res, json } = makeRes();
    maxLength('title', 3)(makeReq({ title: 'toolong' }), res, next);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/title.*3|3.*title/i) }));
  });
});

// ── validateStringLengths ────────────────────────────────────────────────────

describe('validateStringLengths', () => {
  it('calls next() when all fields are within limits', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    validateStringLengths({ name: 10, bio: 100 })(makeReq({ name: 'Alice', bio: 'A short bio' }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 400 on first field that exceeds its limit', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();
    validateStringLengths({ name: 3 })(makeReq({ name: 'toolong' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });

  it('skips fields not present in body', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    validateStringLengths({ name: 10, missing: 5 })(makeReq({ name: 'Alice' }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('skips non-string fields', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    validateStringLengths({ count: 5 })(makeReq({ count: 999999 }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('handles empty maxLengths object — calls next()', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    validateStringLengths({})(makeReq({ anything: 'value' }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next() only once even if multiple fields are valid', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    validateStringLengths({ a: 10, b: 10 })(makeReq({ a: 'ok', b: 'ok' }), res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
