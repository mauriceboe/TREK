import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

let JWT_SECRET: string = process.env.JWT_SECRET || '';

if (!JWT_SECRET) {
  const dataDir = path.resolve(__dirname, '../data');
  const secretFile = path.join(dataDir, '.jwt_secret');

  try {
    JWT_SECRET = fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    JWT_SECRET = crypto.randomBytes(32).toString('hex');
    try {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(secretFile, JWT_SECRET, { mode: 0o600 });
      console.log('Generated and saved JWT secret to', secretFile);
    } catch (writeErr: unknown) {
      console.warn('WARNING: Could not persist JWT secret to disk:', writeErr instanceof Error ? writeErr.message : writeErr);
      console.warn('Sessions will reset on server restart. Set JWT_SECRET env var for persistent sessions.');
    }
  }
}

const JWT_SECRET_IS_GENERATED = !process.env.JWT_SECRET;

export { JWT_SECRET, JWT_SECRET_IS_GENERATED };
