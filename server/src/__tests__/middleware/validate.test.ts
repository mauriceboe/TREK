import { describe, it, expect, vi } from 'vitest';
import { maxLength, validateStringLengths } from '../../middleware/validate';
import type { Request, Response, NextFunction } from 'express';

function mockReqResNext(body: Record<string, unknown> = {}) {
  const req = { body } as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe('maxLength', () => {
  it('calls next when field is within limit', () => {
    const middleware = maxLength('title', 100);
    const { req, res, next } = mockReqResNext({ title: 'Short title' });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next when field is exactly at limit', () => {
    const middleware = maxLength('title', 5);
    const { req, res, next } = mockReqResNext({ title: 'abcde' });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects when field exceeds limit', () => {
    const middleware = maxLength('title', 5);
    const { req, res, next } = mockReqResNext({ title: 'abcdef' });
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'title must be 5 characters or less',
    });
  });

  it('calls next when field is missing from body', () => {
    const middleware = maxLength('title', 5);
    const { req, res, next } = mockReqResNext({});
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next when field is not a string', () => {
    const middleware = maxLength('count', 5);
    const { req, res, next } = mockReqResNext({ count: 123456 });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('validateStringLengths', () => {
  it('calls next when all fields are within limits', () => {
    const middleware = validateStringLengths({ title: 100, name: 50 });
    const { req, res, next } = mockReqResNext({ title: 'ok', name: 'also ok' });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects on the first field that exceeds its limit', () => {
    const middleware = validateStringLengths({ title: 3, name: 50 });
    const { req, res, next } = mockReqResNext({ title: 'too long', name: 'ok' });
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'title must be 3 characters or less',
    });
  });

  it('skips missing fields', () => {
    const middleware = validateStringLengths({ title: 5, description: 10 });
    const { req, res, next } = mockReqResNext({ title: 'ok' });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('skips non-string fields', () => {
    const middleware = validateStringLengths({ count: 2 });
    const { req, res, next } = mockReqResNext({ count: 99999 });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next when body is empty', () => {
    const middleware = validateStringLengths({ title: 5 });
    const { req, res, next } = mockReqResNext({});
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
