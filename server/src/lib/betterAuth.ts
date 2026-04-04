import type { Request } from 'express';
import fetch, { Response as FetchResponse } from 'node-fetch';

export const REGISTRATION_DISABLED_MESSAGE = 'Registration is disabled. Contact your administrator.';

interface BetterAuthSession {
  user?: Record<string, unknown>;
  session?: Record<string, unknown>;
}

interface BetterAuthResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
}

function getConvexAuthBaseUrl(): string {
  const siteUrl = (process.env.CONVEX_SITE_URL || '').trim().replace(/\/$/, '');
  if (!siteUrl) {
    throw new Error('CONVEX_SITE_URL is not configured');
  }
  return `${siteUrl}/api/auth`;
}

function maybeSetHeader(headers: Record<string, string>, name: string, value: unknown): void {
  if (typeof value === 'string' && value.trim()) {
    headers[name] = value;
  }
}

function buildForwardedHeaders(req?: Request, includeJson = false): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (includeJson) {
    headers['Content-Type'] = 'application/json';
  }
  if (req) {
    maybeSetHeader(headers, 'Better-Auth-Cookie', req.headers['better-auth-cookie']);
    maybeSetHeader(headers, 'User-Agent', req.headers['user-agent']);
    maybeSetHeader(headers, 'X-Forwarded-For', req.ip);
  }
  return headers;
}

async function readJson<T>(response: FetchResponse): Promise<T | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function requestBetterAuth<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST';
    req?: Request;
    body?: Record<string, unknown>;
  } = {}
): Promise<BetterAuthResponse<T>> {
  const response = await fetch(`${getConvexAuthBaseUrl()}${path}`, {
    method: options.method || (options.body ? 'POST' : 'GET'),
    headers: buildForwardedHeaders(options.req, Boolean(options.body)),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await readJson<T>(response);
  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

export async function getBetterAuthSession(req: Request, options?: { disableRefresh?: boolean }): Promise<BetterAuthSession | null> {
  const query = options?.disableRefresh ? '?disableRefresh=true' : '';
  const result = await requestBetterAuth<BetterAuthSession>(`/get-session${query}`, { req });
  if (!result.ok || !result.data?.user) return null;
  return result.data;
}

export async function signUpBetterAuthEmail(body: {
  email: string;
  password: string;
  name: string;
  username?: string;
  displayUsername?: string;
}): Promise<BetterAuthResponse<{ user?: Record<string, unknown>; token?: string | null; error?: { message?: string } }>> {
  return requestBetterAuth('/sign-up/email', { body });
}

export async function signInBetterAuthEmail(body: {
  email: string;
  password: string;
}): Promise<BetterAuthResponse<{ user?: Record<string, unknown>; token?: string | null; error?: { message?: string } }>> {
  return requestBetterAuth('/sign-in/email', { body });
}

export async function updateBetterAuthUser(req: Request, body: Record<string, unknown>): Promise<BetterAuthResponse<{ user?: Record<string, unknown>; error?: { message?: string } }>> {
  return requestBetterAuth('/update-user', { req, body });
}

export async function changeBetterAuthPassword(req: Request, body: {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions?: boolean;
}): Promise<BetterAuthResponse<{ success?: boolean; error?: { message?: string } }>> {
  return requestBetterAuth('/change-password', { req, body });
}

export async function deleteBetterAuthUser(req: Request): Promise<BetterAuthResponse<{ success?: boolean; error?: { message?: string } }>> {
  return requestBetterAuth('/delete-user', { req, body: {} });
}

export async function signOutBetterAuth(req: Request): Promise<BetterAuthResponse<{ success?: boolean; error?: { message?: string } }>> {
  return requestBetterAuth('/sign-out', { req, body: {} });
}
