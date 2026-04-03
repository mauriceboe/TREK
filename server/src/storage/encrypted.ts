import { Readable, Transform } from 'stream';
import fs from 'fs';
import path from 'path';
import { StorageBackend, DownloadResult, ListEntry } from './types';
import { createEncryptionStream, createDecryptionStream } from './crypto';

export class EncryptedBackend implements StorageBackend {
  constructor(private backend: StorageBackend) {}

  async store(key: string, data: Buffer | Readable): Promise<void> {
    const { cipher, iv, salt, getAuthTag } = createEncryptionStream();
    
    if (Buffer.isBuffer(data)) {
      const encrypted = Buffer.concat([
        cipher.update(data),
        cipher.final()
      ]);
      const authTag = getAuthTag();
      
      const metadata = Buffer.concat([salt, iv, authTag]);
      const combined = Buffer.concat([metadata, encrypted]);
      
      await this.backend.store(key, combined);
    } else {
      // Write encrypted data to a temp file to avoid buffering large streams in memory
      const tmpDir = path.join(__dirname, '../../data/tmp');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const tmpPath = path.join(tmpDir, `trek-enc-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);

      // Register metadataPromise BEFORE piping to avoid missing 'end' on short streams
      const metadataPromise = new Promise<Buffer>((resolve) => {
        cipher.on('end', () => {
          const authTag = getAuthTag();
          resolve(Buffer.concat([salt, iv, authTag]));
        });
      });

      const writeStream = fs.createWriteStream(tmpPath);
      data.pipe(cipher).pipe(writeStream);

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        cipher.on('error', reject);
      });

      const metadata = await metadataPromise;

      async function* combined() {
        yield metadata;
        yield* fs.createReadStream(tmpPath);
      }

      try {
        await this.backend.store(key, Readable.from(combined()));
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    }
  }

  async download(key: string): Promise<DownloadResult> {
    const result = await this.backend.download(key);
    
    if (result.type === 'redirect') {
      throw new Error('Cannot decrypt presigned URLs - encryption requires streaming through server');
    }

    const SALT_LENGTH = 32;
    const IV_LENGTH = 16;
    const AUTH_TAG_LENGTH = 16;
    const METADATA_LENGTH = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;

    const chunks: Buffer[] = [];
    let metadataRead = false;
    let iv: Buffer;
    let authTag: Buffer;
    let decipher: any;

    const decryptStream = new Transform({
      transform(chunk: Buffer, encoding, callback) {
        if (!metadataRead) {
          chunks.push(chunk);
          const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
          
          if (totalLength >= METADATA_LENGTH) {
            const combined = Buffer.concat(chunks);
            const salt = combined.subarray(0, SALT_LENGTH);
            iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
            authTag = combined.subarray(SALT_LENGTH + IV_LENGTH, METADATA_LENGTH);
            const remaining = combined.subarray(METADATA_LENGTH);
            
            decipher = createDecryptionStream(iv, authTag, salt);
            metadataRead = true;
            
            if (remaining.length > 0) {
              this.push(decipher.update(remaining));
            }
          }
          callback();
        } else {
          this.push(decipher.update(chunk));
          callback();
        }
      },
      flush(callback) {
        if (decipher) {
          try {
            this.push(decipher.final());
          } catch (err) {
            return callback(err as Error);
          }
        }
        callback();
      }
    });

    result.stream.on('error', (err) => decryptStream.destroy(err));
    result.stream.pipe(decryptStream);
    
    return { type: 'stream', stream: decryptStream };
  }

  async list(): Promise<ListEntry[]> {
    return this.backend.list();
  }

  async delete(key: string): Promise<void> {
    return this.backend.delete(key);
  }

  async testConnection(): Promise<void> {
    return this.backend.testConnection();
  }
}
