import crypto, { KeyObject, createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Request } from 'express';
import { exportJWK, jwtVerify, SignJWT } from 'jose';

const CONVEX_APPLICATION_ID = process.env.CONVEX_APPLICATION_ID || 'trek-web';
const CONVEX_ISSUER_PATH = '/api/auth/convex';
const KEY_ALGORITHM = 'RS256';

interface ConvexAuthUser {
  id: number;
  username: string;
  email: string;
  role: string;
  avatar_url?: string | null;
}

interface ConvexKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  privatePem: string;
  publicPem: string;
  kid: string;
}

let cachedKeyPair: ConvexKeyPair | null = null;

function getIssuerBase(): string {
  return (process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');
}

function getKeyPair(): ConvexKeyPair {
  if (cachedKeyPair) return cachedKeyPair;

  const envPrivate = process.env.CONVEX_JWT_PRIVATE_KEY;
  const envPublic = process.env.CONVEX_JWT_PUBLIC_KEY;
  let privatePem = envPrivate || '';
  let publicPem = envPublic || '';

  if (!privatePem || !publicPem) {
    const dataDir = path.resolve(__dirname, '../../data');
    const privateFile = path.join(dataDir, '.convex_jwt_private.pem');
    const publicFile = path.join(dataDir, '.convex_jwt_public.pem');

    try {
      privatePem = fs.readFileSync(privateFile, 'utf8');
      publicPem = fs.readFileSync(publicFile, 'utf8');
    } catch {
      const generated = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
        publicKeyEncoding: { format: 'pem', type: 'spki' },
      });
      privatePem = generated.privateKey;
      publicPem = generated.publicKey;

      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(privateFile, privatePem, { mode: 0o600 });
      fs.writeFileSync(publicFile, publicPem, { mode: 0o644 });
    }
  }

  const kid = process.env.CONVEX_JWT_KID || createHash('sha256').update(publicPem).digest('hex').slice(0, 16);
  cachedKeyPair = {
    privateKey: createPrivateKey(privatePem),
    publicKey: createPublicKey(publicPem),
    privatePem,
    publicPem,
    kid,
  };
  return cachedKeyPair;
}

function getConvexIssuer(_req?: Request): string {
  return (process.env.CONVEX_AUTH_ISSUER_URL || `${getIssuerBase()}${CONVEX_ISSUER_PATH}`).replace(/\/$/, '');
}

async function getConvexJwks(): Promise<{ keys: Record<string, unknown>[] }> {
  const { publicKey, kid } = getKeyPair();
  const jwk = await exportJWK(publicKey);
  return {
    keys: [{ ...jwk, use: 'sig', alg: KEY_ALGORITHM, kid }],
  };
}

function getConvexOpenIdConfiguration(req: Request): Record<string, unknown> {
  const issuer = getConvexIssuer(req);
  return {
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    id_token_signing_alg_values_supported: [KEY_ALGORITHM],
    response_types_supported: ['id_token'],
    subject_types_supported: ['public'],
    claims_supported: ['sub', 'aud', 'iss', 'exp', 'iat', 'email', 'name', 'role', 'avatar_url', 'trip_ids'],
  };
}

async function signConvexToken(req: Request, user: ConvexAuthUser, tripIds: number[]): Promise<string> {
  const { privateKey, kid } = getKeyPair();
  return new SignJWT({
    email: user.email,
    name: user.username,
    role: user.role,
    avatar_url: user.avatar_url || null,
    trip_ids: tripIds,
  })
    .setProtectedHeader({ alg: KEY_ALGORITHM, kid })
    .setIssuer(getConvexIssuer(req))
    .setAudience(CONVEX_APPLICATION_ID)
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(privateKey);
}

async function verifyConvexToken(token: string): Promise<Record<string, unknown>> {
  const { publicKey } = getKeyPair();
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: getConvexIssuer(),
    audience: CONVEX_APPLICATION_ID,
  });
  return payload as Record<string, unknown>;
}

export { CONVEX_APPLICATION_ID, getConvexIssuer, getConvexJwks, getConvexOpenIdConfiguration, signConvexToken, verifyConvexToken };
