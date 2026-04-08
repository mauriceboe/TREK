import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../../src/config';

export function generateToken(userId: number): string {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '24h' });
}

export function authCookie(userId: number): string {
  return `auth_token=${encodeURIComponent(generateToken(userId))}`;
}
