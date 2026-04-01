import cron, { type ScheduledTask } from 'node-cron';
import archiver from 'archiver';
import path from 'path';
import fs from 'fs';

const dataDir = path.join(__dirname, '../data');
const backupsDir = path.join(dataDir, 'backups');
const uploadsDir = path.join(__dirname, '../uploads');
const settingsFile = path.join(dataDir, 'backup-settings.json');

const VALID_INTERVALS = ['hourly', 'daily', 'weekly', 'monthly'];
const VALID_DAYS_OF_WEEK = [0, 1, 2, 3, 4, 5, 6]; // 0=Sunday
const VALID_HOURS = Array.from({ length: 24 }, (_, i) => i);

interface BackupSettings {
  enabled: boolean;
  interval: string;
  keep_days: number;
  hour: number;
  day_of_week: number;
  day_of_month: number;
}

function buildCronExpression(settings: BackupSettings): string {
  const hour = VALID_HOURS.includes(settings.hour) ? settings.hour : 2;
  const dow = VALID_DAYS_OF_WEEK.includes(settings.day_of_week) ? settings.day_of_week : 0;
  const dom = settings.day_of_month >= 1 && settings.day_of_month <= 28 ? settings.day_of_month : 1;

  switch (settings.interval) {
    case 'hourly':  return '0 * * * *';
    case 'daily':   return `0 ${hour} * * *`;
    case 'weekly':  return `0 ${hour} * * ${dow}`;
    case 'monthly': return `0 ${hour} ${dom} * *`;
    default:        return `0 ${hour} * * *`;
  }
}

let currentTask: ScheduledTask | null = null;

function getDefaults(): BackupSettings {
  return { enabled: false, interval: 'daily', keep_days: 7, hour: 2, day_of_week: 0, day_of_month: 1 };
}

function loadSettings(): BackupSettings {
  let settings = getDefaults();
  try {
    if (fs.existsSync(settingsFile)) {
      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      settings = { ...settings, ...saved };
    }
  } catch (e) {}
  return settings;
}

function saveSettings(settings: BackupSettings): void {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

async function runBackup(): Promise<void> {
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `auto-backup-${timestamp}.zip`;
  const outputPath = path.join(backupsDir, filename);

  try {
    // Flush WAL to main DB file before archiving
    try { const { db } = require('./db/database'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      const dbPath = path.join(dataDir, 'travel.db');
      if (fs.existsSync(dbPath)) archive.file(dbPath, { name: 'travel.db' });
      if (fs.existsSync(uploadsDir)) archive.directory(uploadsDir, 'uploads');
      archive.finalize();
    });
    const { logInfo: li } = require('./services/auditLog');
    li(`Auto-Backup created: ${filename}`);
  } catch (err: unknown) {
    const { logError: le } = require('./services/auditLog');
    le(`Auto-Backup: ${err instanceof Error ? err.message : err}`);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return;
  }

  const settings = loadSettings();
  if (settings.keep_days > 0) {
    cleanupOldBackups(settings.keep_days);
  }
}

function cleanupOldBackups(keepDays: number): void {
  try {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - keepDays * MS_PER_DAY;
    const files = fs.readdirSync(backupsDir).filter(f => f.endsWith('.zip'));
    for (const file of files) {
      const filePath = path.join(backupsDir, file);
      const stat = fs.statSync(filePath);
      if (stat.birthtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        const { logInfo: li } = require('./services/auditLog');
        li(`Auto-Backup old backup deleted: ${file}`);
      }
    }
  } catch (err: unknown) {
    const { logError: le } = require('./services/auditLog');
    le(`Auto-Backup cleanup: ${err instanceof Error ? err.message : err}`);
  }
}

function start(): void {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }

  const settings = loadSettings();
  if (!settings.enabled) {
    const { logInfo: li } = require('./services/auditLog');
    li('Auto-Backup disabled');
    return;
  }

  const expression = buildCronExpression(settings);
  const tz = process.env.TZ || 'UTC';
  currentTask = cron.schedule(expression, runBackup, { timezone: tz });
  const { logInfo: li2 } = require('./services/auditLog');
  li2(`Auto-Backup scheduled: ${settings.interval} (${expression}), tz: ${tz}, retention: ${settings.keep_days === 0 ? 'forever' : settings.keep_days + ' days'}`);
}

// Demo mode: hourly reset of demo user data
let demoTask: ScheduledTask | null = null;

function startDemoReset(): void {
  if (demoTask) { demoTask.stop(); demoTask = null; }
  if (process.env.DEMO_MODE !== 'true') return;

  demoTask = cron.schedule('0 * * * *', () => {
    try {
      const { resetDemoUser } = require('./demo/demo-reset');
      resetDemoUser();
    } catch (err: unknown) {
      const { logError: le } = require('./services/auditLog');
      le(`Demo reset: ${err instanceof Error ? err.message : err}`);
    }
  });
  const { logInfo: li3 } = require('./services/auditLog');
  li3('Demo hourly reset scheduled');
}

// Trip reminders: daily check at 9 AM local time for trips starting tomorrow
let reminderTask: ScheduledTask | null = null;

function startTripReminders(): void {
  if (reminderTask) { reminderTask.stop(); reminderTask = null; }

  try {
    const { db } = require('./db/database');
    const getSetting = (key: string) => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    const channel = getSetting('notification_channel') || 'none';
    const reminderEnabled = getSetting('notify_trip_reminder') !== 'false';
    const hasSmtp = !!(getSetting('smtp_host') || '').trim();
    const hasWebhook = !!(getSetting('notification_webhook_url') || '').trim();
    const channelReady = (channel === 'email' && hasSmtp) || (channel === 'webhook' && hasWebhook);

    if (!channelReady || !reminderEnabled) {
      const { logInfo: li } = require('./services/auditLog');
      const reason = !channelReady ? `no ${channel === 'none' ? 'notification channel' : channel} configuration` : 'trip reminders disabled in settings';
      li(`Trip reminders: disabled (${reason})`);
      return;
    }

    const tripCount = (db.prepare('SELECT COUNT(*) as c FROM trips WHERE reminder_days > 0 AND start_date IS NOT NULL').get() as { c: number }).c;
    const { logInfo: liSetup } = require('./services/auditLog');
    liSetup(`Trip reminders: enabled via ${channel}${tripCount > 0 ? `, ${tripCount} trip(s) with active reminders` : ''}`);
  } catch {
    return;
  }

  const tz = process.env.TZ || 'UTC';
  reminderTask = cron.schedule('0 9 * * *', async () => {
    try {
      const { db } = require('./db/database');
      const { notifyTripMembers } = require('./services/notifications');

      const trips = db.prepare(`
        SELECT t.id, t.title, t.user_id, t.reminder_days FROM trips t
        WHERE t.reminder_days > 0
          AND t.start_date IS NOT NULL
          AND t.start_date = date('now', '+' || t.reminder_days || ' days')
      `).all() as { id: number; title: string; user_id: number; reminder_days: number }[];

      for (const trip of trips) {
        await notifyTripMembers(trip.id, 0, 'trip_reminder', { trip: trip.title }).catch(() => {});
      }

      const { logInfo: li } = require('./services/auditLog');
      if (trips.length > 0) {
        li(`Trip reminders sent for ${trips.length} trip(s): ${trips.map(t => `"${t.title}" (${t.reminder_days}d)`).join(', ')}`);
      }
    } catch (err: unknown) {
      const { logError: le } = require('./services/auditLog');
      le(`Trip reminder check failed: ${err instanceof Error ? err.message : err}`);
    }
  }, { timezone: tz });
}

function stop(): void {
  if (currentTask) { currentTask.stop(); currentTask = null; }
  if (demoTask) { demoTask.stop(); demoTask = null; }
  if (reminderTask) { reminderTask.stop(); reminderTask = null; }
}

export { start, stop, startDemoReset, startTripReminders, loadSettings, saveSettings, VALID_INTERVALS };
