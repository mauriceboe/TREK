import { db } from '../db/database';
import { StorageBackend, StoragePurpose, StorageTarget, S3Config } from './types';
import { LocalBackend } from './local';
import { S3Backend } from './s3';
import { EncryptedBackend } from './encrypted';
import { decryptCredentials } from './crypto';

const backendCache = new Map<string, StorageBackend>();

export function getBackend(purpose: StoragePurpose): StorageBackend {
  const assignment = db.prepare(
    'SELECT target_id FROM storage_assignments WHERE purpose = ?'
  ).get(purpose) as { target_id: number | null } | undefined;

  const targetId = assignment?.target_id ?? null;

  if (targetId === null) {
    const cacheKey = `local:${purpose}`;
    if (!backendCache.has(cacheKey)) {
      backendCache.set(cacheKey, new LocalBackend(purpose));
    }
    return backendCache.get(cacheKey)!;
  }

  const numericCacheKey = `target:${targetId}`;
  if (backendCache.has(numericCacheKey)) {
    return backendCache.get(numericCacheKey)!;
  }

  const target = db.prepare(
    'SELECT * FROM storage_targets WHERE id = ?'
  ).get(targetId) as StorageTarget | undefined;

  if (!target) {
    throw new Error(`Storage target ${targetId} not found`);
  }

  if (!target.enabled) {
    throw new Error(`Storage target "${target.name}" (id: ${targetId}) is disabled`);
  }

  const configJson = decryptCredentials(target.config_encrypted);
  const config = JSON.parse(configJson) as S3Config;

  let backend: StorageBackend;

  if (target.type === 's3') {
    // Disable presigned URLs for backup purpose to ensure restore works
    const s3Config = purpose === 'backup'
      ? { ...config, use_presigned_urls: false }
      : config;
    backend = new S3Backend(s3Config, targetId, target.name);
  } else {
    throw new Error(`Unknown storage target type: ${target.type}`);
  }

  if (target.encrypt === 1) {
    backend = new EncryptedBackend(backend);
  }

  backendCache.set(numericCacheKey, backend);
  return backend;
}

export function invalidateBackendCache(targetId?: number): void {
  if (targetId !== undefined) {
    backendCache.delete(`target:${targetId}`);
  } else {
    backendCache.clear();
  }
}

export function getTargetNameForSource(source: string): string {
  if (source === 'local') {
    return 'Local';
  }
  
  const match = source.match(/^target:(\d+)$/);
  if (!match) {
    return 'Unknown';
  }
  
  const targetId = parseInt(match[1], 10);
  const target = db.prepare(
    'SELECT name FROM storage_targets WHERE id = ?'
  ).get(targetId) as { name: string } | undefined;
  
  return target?.name ?? 'Unknown';
}
