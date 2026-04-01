import { Response } from 'express';

const COOKIE_NAME = 'trek_session';

function cookieOptions(clear = false) {
  const secure = process.env.COOKIE_SECURE !== 'false' && (process.env.NODE_ENV === 'production' || process.env.FORCE_HTTPS === 'true');
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict' as const,
    path: '/',
    ...(clear ? {} : { maxAge: 24 * 60 * 60 * 1000 }), // 24h — matches JWT expiry
  };
}

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, cookieOptions(true));
}
