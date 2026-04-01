import * as crypto from 'crypto';
import { ENCRYPTION_KEY } from '../config';

const ENCRYPTED_PREFIX = 'enc:v1:';

function get_key() {
  return crypto.createHash('sha256').update(`${ENCRYPTION_KEY}:api_keys:v1`).digest();
}

export function encrypt_api_key(plain: unknown) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', get_key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, enc]).toString('base64');
  return `${ENCRYPTED_PREFIX}${blob}`;
}

export function decrypt_api_key(value: unknown) {
  if (!value) return null;
  if (typeof value !== 'string') return null;
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value; // legacy plaintext
  const blob = value.slice(ENCRYPTED_PREFIX.length);
  try {
    const buf = Buffer.from(blob, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', get_key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function maybe_encrypt_api_key(value: unknown) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(ENCRYPTED_PREFIX)) return trimmed;
  return encrypt_api_key(trimmed);
}

