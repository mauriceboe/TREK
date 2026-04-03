/**
 * Auth helpers for integration tests.
 *
 * Provides utilities to generate JWTs and authenticate supertest requests
 * using the fixed test JWT_SECRET from TEST_CONFIG.
 */

import jwt from 'jsonwebtoken';
import { TEST_CONFIG } from './test-db';

/** Signs a JWT for the given user ID using the test secret. */
export function generateToken(userId: number, extraClaims: Record<string, unknown> = {}): string {
  return jwt.sign(
    { id: userId, ...extraClaims },
    TEST_CONFIG.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

/**
 * Returns a cookie string suitable for supertest:
 *   request(app).get('/api/...').set('Cookie', authCookie(userId))
 */
export function authCookie(userId: number): string {
  return `trek_session=${generateToken(userId)}`;
}

/**
 * Returns an Authorization header object suitable for supertest:
 *   request(app).get('/api/...').set(authHeader(userId))
 */
export function authHeader(userId: number): Record<string, string> {
  return { Authorization: `Bearer ${generateToken(userId)}` };
}
