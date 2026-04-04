import crypto from 'crypto';

const TTL: Record<string, number> = {
  ws: 30_000,
  download: 60_000,
  immich: 60_000,
};

const MAX_STORE_SIZE = 10_000;

interface TokenEntry {
  userId: number;
  purpose: string;
  expiresAt: number;
}

const store = new Map<string, TokenEntry>();

export function createEphemeralToken(userId: number, purpose: string): string | null {
  if (store.size >= MAX_STORE_SIZE) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = TTL[purpose] ?? 60_000;
  store.set(token, { userId, purpose, expiresAt: Date.now() + ttl });
  return token;
}

export function consumeEphemeralToken(token: string, purpose: string): number | null {
  const entry = store.get(token);
  if (!entry) return null;
  store.delete(token);
  if (entry.purpose !== purpose || Date.now() > entry.expiresAt) return null;
  return entry.userId;
}

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startTokenCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of store) {
      if (now > entry.expiresAt) store.delete(token);
    }
  }, 60_000);
  // Allow process to exit even if interval is active
  if (cleanupInterval.unref) cleanupInterval.unref();
}

export function stopTokenCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
