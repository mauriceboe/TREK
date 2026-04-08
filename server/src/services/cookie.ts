export interface CookieOptions {
  httpOnly: boolean;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
  maxAge?: number;
}

export function cookieOptions(clear = false): CookieOptions {
  const secure = process.env.COOKIE_SECURE === 'true'
    || (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production')
    || process.env.FORCE_HTTPS === 'true';

  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    ...(clear ? {} : { maxAge: 24 * 60 * 60 * 1000 }),
  };
}
