import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const mockCanAccessTrip = vi.fn();
const mockIsOwner = vi.fn();

vi.mock('../../db/database', () => ({
  canAccessTrip: (...args: unknown[]) => mockCanAccessTrip(...args),
  isOwner: (...args: unknown[]) => mockIsOwner(...args),
}));

import { requireTripAccess, requireTripOwner } from '../../middleware/tripAccess';

function mockRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('requireTripAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when no trip ID in params', () => {
    const req = { params: {}, user: { id: 1 } } as any;
    const res = mockRes();
    const next = vi.fn();
    requireTripAccess(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Trip ID required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 404 when user cannot access trip', () => {
    mockCanAccessTrip.mockReturnValue(undefined);
    const req = { params: { tripId: '42' }, user: { id: 1 } } as any;
    const res = mockRes();
    const next = vi.fn();
    requireTripAccess(req, res, next);
    expect(mockCanAccessTrip).toHaveBeenCalledWith(42, 1);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Trip not found' });
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches trip and calls next when user has access', () => {
    const trip = { id: 42, user_id: 1 };
    mockCanAccessTrip.mockReturnValue(trip);
    const req = { params: { tripId: '42' }, user: { id: 1 } } as any;
    const res = mockRes();
    const next = vi.fn();
    requireTripAccess(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.trip).toEqual(trip);
  });

  it('reads tripId from params.id as fallback', () => {
    const trip = { id: 10, user_id: 1 };
    mockCanAccessTrip.mockReturnValue(trip);
    const req = { params: { id: '10' }, user: { id: 1 } } as any;
    const res = mockRes();
    const next = vi.fn();
    requireTripAccess(req, res, next);
    expect(mockCanAccessTrip).toHaveBeenCalledWith(10, 1);
    expect(next).toHaveBeenCalled();
  });

  it('allows trip member (not just owner) to access', () => {
    // canAccessTrip returns trip data when user is a member
    const trip = { id: 42, user_id: 99 }; // user_id is different from requesting user
    mockCanAccessTrip.mockReturnValue(trip);
    const req = { params: { tripId: '42' }, user: { id: 5 } } as any;
    const res = mockRes();
    const next = vi.fn();
    requireTripAccess(req, res, next);
    expect(mockCanAccessTrip).toHaveBeenCalledWith(42, 5);
    expect(next).toHaveBeenCalled();
  });
});

describe('requireTripOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when no trip ID in params', () => {
    const req = { params: {}, user: { id: 1 } } as any;
    const res = mockRes();
    const next = vi.fn();
    requireTripOwner(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Trip ID required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when user is not the owner', () => {
    mockIsOwner.mockReturnValue(false);
    const req = { params: { tripId: '42' }, user: { id: 5 } } as any;
    const res = mockRes();
    const next = vi.fn();
    requireTripOwner(req, res, next);
    expect(mockIsOwner).toHaveBeenCalledWith(42, 5);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Only the trip owner can do this' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when user is the owner', () => {
    mockIsOwner.mockReturnValue(true);
    const req = { params: { tripId: '42' }, user: { id: 1 } } as any;
    const res = mockRes();
    const next = vi.fn();
    requireTripOwner(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('reads tripId from params.id as fallback', () => {
    mockIsOwner.mockReturnValue(true);
    const req = { params: { id: '10' }, user: { id: 1 } } as any;
    const res = mockRes();
    const next = vi.fn();
    requireTripOwner(req, res, next);
    expect(mockIsOwner).toHaveBeenCalledWith(10, 1);
    expect(next).toHaveBeenCalled();
  });
});
