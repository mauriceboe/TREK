import express, { Request, Response, NextFunction } from 'express';
import archiver from 'archiver';
import unzipper from 'unzipper';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { authenticate, adminOnly } from '../middleware/auth';
import * as scheduler from '../scheduler';
import { db, closeDb, reinitialize } from '../db/database';
import { AuthRequest } from '../types';
import { writeAudit, getClientIp } from '../services/auditLog';

type RestoreAuditInfo = { userId: number; ip: string | null; source: 'backup.restore' | 'backup.upload_restore'; label: string };

const router = express.Router();

router.use(authenticate, adminOnly);

const BACKUP_RATE_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_BACKUP_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB

const backupAttempts = new Map<string, { count: number; first: number }>();
function backupRateLimiter(maxAttempts: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const record = backupAttempts.get(key);
    if (record && record.count >= maxAttempts && now - record.first < windowMs) {
      return res.status(429).json({ error: 'Too many backup requests. Please try again later.' });
    }
    if (!record || now - record.first >= windowMs) {
      backupAttempts.set(key, { count: 1, first: now });
    } else {
      record.count++;
    }
    next();
  };
}

const dataDir = path.join(__dirname, '../../data');
const backupsDir = path.join(dataDir, 'backups');
const uploadsDir = path.join(__dirname, '../../uploads');

function ensureBackupsDir() {
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

router.get('/list', (_req: Request, res: Response) => {
  ensureBackupsDir();

  try {
    const files = fs.readdirSync(backupsDir)
      .filter(f => f.endsWith('.zip'))
      .map(filename => {
        const filePath = path.join(backupsDir, filename);
        const stat = fs.statSync(filePath);
        return {
          filename,
          size: stat.size,
          sizeText: formatSize(stat.size),
          created_at: stat.birthtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    res.json({ backups: files });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Error loading backups' });
  }
});

router.post('/create', backupRateLimiter(3, BACKUP_RATE_WINDOW), async (_req: Request, res: Response) => {
  ensureBackupsDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `backup-${timestamp}.zip`;
  const outputPath = path.join(backupsDir, filename);

  try {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', resolve);
      archive.on('error', reject);

      archive.pipe(output);

      const dbPath = path.join(dataDir, 'travel.db');
      if (fs.existsSync(dbPath)) {
        archive.file(dbPath, { name: 'travel.db' });
      }

      if (fs.existsSync(uploadsDir)) {
        archive.directory(uploadsDir, 'uploads');
      }

      archive.finalize();
    });

    const stat = fs.statSync(outputPath);
    const authReq = _req as AuthRequest;
    writeAudit({
      userId: authReq.user.id,
      action: 'backup.create',
      resource: filename,
      ip: getClientIp(_req),
      details: { size: stat.size },
    });
    res.json({
      success: true,
      backup: {
        filename,
        size: stat.size,
        sizeText: formatSize(stat.size),
        created_at: stat.birthtime.toISOString(),
      }
    });
  } catch (err: unknown) {
    console.error('Backup error:', err);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.status(500).json({ error: 'Error creating backup' });
  }
});

router.get('/download/:filename', (req: Request, res: Response) => {
  const { filename } = req.params;

  if (!/^backup-[\w\-]+\.zip$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(backupsDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }

  res.download(filePath, filename);
});

async function restoreFromZip(zipPath: string, res: Response, audit?: RestoreAuditInfo) {
  const extractDir = path.join(dataDir, `restore-${Date.now()}`);
  try {
    await fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractDir }))
      .promise();

    const extractedDb = path.join(extractDir, 'travel.db');
    if (!fs.existsSync(extractedDb)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
      return res.status(400).json({ error: 'Invalid backup: travel.db not found' });
    }

    let uploadedDb: InstanceType<typeof Database> | null = null;
    try {
      uploadedDb = new Database(extractedDb, { readonly: true });

      const integrityResult = uploadedDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (integrityResult.integrity_check !== 'ok') {
        fs.rmSync(extractDir, { recursive: true, force: true });
        return res.status(400).json({ error: `Uploaded database failed integrity check: ${integrityResult.integrity_check}` });
      }

      const requiredTables = ['users', 'trips', 'trip_members', 'places', 'days'];
      const existingTables = uploadedDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      const tableNames = new Set(existingTables.map(t => t.name));
      for (const table of requiredTables) {
        if (!tableNames.has(table)) {
          fs.rmSync(extractDir, { recursive: true, force: true });
          return res.status(400).json({ error: `Uploaded database is missing required table: ${table}. This does not appear to be a TREK backup.` });
        }
      }
    } catch (err) {
      fs.rmSync(extractDir, { recursive: true, force: true });
      return res.status(400).json({ error: 'Uploaded file is not a valid SQLite database' });
    } finally {
      uploadedDb?.close();
    }

    closeDb();

    try {
      const dbDest = path.join(dataDir, 'travel.db');
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbDest + ext); } catch (e) {}
      }
      fs.copyFileSync(extractedDb, dbDest);

      const extractedUploads = path.join(extractDir, 'uploads');
      if (fs.existsSync(extractedUploads)) {
        for (const sub of fs.readdirSync(uploadsDir)) {
          const subPath = path.join(uploadsDir, sub);
          if (fs.statSync(subPath).isDirectory()) {
            for (const file of fs.readdirSync(subPath)) {
              try { fs.unlinkSync(path.join(subPath, file)); } catch (e) {}
            }
          }
        }
        fs.cpSync(extractedUploads, uploadsDir, { recursive: true, force: true });
      }
    } finally {
      reinitialize();
    }

    fs.rmSync(extractDir, { recursive: true, force: true });

    if (audit) {
      writeAudit({
        userId: audit.userId,
        action: audit.source,
        resource: audit.label,
        ip: audit.ip,
      });
    }
    res.json({ success: true });
  } catch (err: unknown) {
    console.error('Restore error:', err);
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    if (!res.headersSent) res.status(500).json({ error: 'Error restoring backup' });
  }
}

router.post('/restore/:filename', async (req: Request, res: Response) => {
  const { filename } = req.params;
  if (!/^backup-[\w\-]+\.zip$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const zipPath = path.join(backupsDir, filename);
  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  const authReq = req as AuthRequest;
  await restoreFromZip(zipPath, res, {
    userId: authReq.user.id,
    ip: getClientIp(req),
    source: 'backup.restore',
    label: filename,
  });
});

const uploadTmp = multer({
  dest: path.join(dataDir, 'tmp/'),
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.zip')) cb(null, true);
    else cb(new Error('Only ZIP files allowed'));
  },
  limits: { fileSize: MAX_BACKUP_UPLOAD_SIZE },
});

router.post('/upload-restore', uploadTmp.single('backup'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const zipPath = req.file.path;
  const authReq = req as AuthRequest;
  const origName = req.file.originalname || 'upload.zip';
  await restoreFromZip(zipPath, res, {
    userId: authReq.user.id,
    ip: getClientIp(req),
    source: 'backup.upload_restore',
    label: origName,
  });
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
});

router.get('/auto-settings', (_req: Request, res: Response) => {
  try {
    const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    res.json({ settings: scheduler.loadSettings(), timezone: tz });
  } catch (err: unknown) {
    console.error('[backup] GET auto-settings:', err);
    res.status(500).json({ error: 'Could not load backup settings' });
  }
});

function parseIntField(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function parseAutoBackupBody(body: Record<string, unknown>): {
  enabled: boolean;
  interval: string;
  keep_days: number;
  hour: number;
  day_of_week: number;
  day_of_month: number;
} {
  const enabled = body.enabled === true || body.enabled === 'true' || body.enabled === 1;
  const rawInterval = body.interval;
  const interval =
    typeof rawInterval === 'string' && scheduler.VALID_INTERVALS.includes(rawInterval)
      ? rawInterval
      : 'daily';
  const keep_days = Math.max(0, parseIntField(body.keep_days, 7));
  const hour = Math.min(23, Math.max(0, parseIntField(body.hour, 2)));
  const day_of_week = Math.min(6, Math.max(0, parseIntField(body.day_of_week, 0)));
  const day_of_month = Math.min(28, Math.max(1, parseIntField(body.day_of_month, 1)));
  return { enabled, interval, keep_days, hour, day_of_week, day_of_month };
}

router.put('/auto-settings', (req: Request, res: Response) => {
  try {
    const settings = parseAutoBackupBody((req.body || {}) as Record<string, unknown>);
    scheduler.saveSettings(settings);
    scheduler.start();
    const authReq = req as AuthRequest;
    writeAudit({
      userId: authReq.user.id,
      action: 'backup.auto_settings',
      ip: getClientIp(req),
      details: { enabled: settings.enabled, interval: settings.interval, keep_days: settings.keep_days },
    });
    res.json({ settings });
  } catch (err: unknown) {
    console.error('[backup] PUT auto-settings:', err);
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      error: 'Could not save auto-backup settings',
      detail: process.env.NODE_ENV !== 'production' ? msg : undefined,
    });
  }
});

router.delete('/:filename', (req: Request, res: Response) => {
  const { filename } = req.params;

  if (!/^backup-[\w\-]+\.zip$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(backupsDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }

  fs.unlinkSync(filePath);
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'backup.delete',
    resource: filename,
    ip: getClientIp(req),
  });
  res.json({ success: true });
});

export default router;
