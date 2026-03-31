"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VALID_INTERVALS = void 0;
exports.start = start;
exports.stop = stop;
exports.startDemoReset = startDemoReset;
exports.loadSettings = loadSettings;
exports.saveSettings = saveSettings;
const node_cron_1 = __importDefault(require("node-cron"));
const archiver_1 = __importDefault(require("archiver"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const dataDir = path_1.default.join(__dirname, '../data');
const backupsDir = path_1.default.join(dataDir, 'backups');
const uploadsDir = path_1.default.join(__dirname, '../data/uploads');
const settingsFile = path_1.default.join(dataDir, 'backup-settings.json');
const CRON_EXPRESSIONS = {
    hourly: '0 * * * *',
    daily: '0 2 * * *',
    weekly: '0 2 * * 0',
    monthly: '0 2 1 * *',
};
const VALID_INTERVALS = Object.keys(CRON_EXPRESSIONS);
exports.VALID_INTERVALS = VALID_INTERVALS;
let currentTask = null;
function loadSettings() {
    try {
        if (fs_1.default.existsSync(settingsFile)) {
            return JSON.parse(fs_1.default.readFileSync(settingsFile, 'utf8'));
        }
    }
    catch (e) { }
    return { enabled: false, interval: 'daily', keep_days: 7 };
}
function saveSettings(settings) {
    if (!fs_1.default.existsSync(dataDir))
        fs_1.default.mkdirSync(dataDir, { recursive: true });
    fs_1.default.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}
async function runBackup() {
    if (!fs_1.default.existsSync(backupsDir))
        fs_1.default.mkdirSync(backupsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `auto-backup-${timestamp}.zip`;
    const outputPath = path_1.default.join(backupsDir, filename);
    try {
        // Flush WAL to main DB file before archiving
        try {
            const { db } = require('./db/database');
            db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        }
        catch (e) { }
        await new Promise((resolve, reject) => {
            const output = fs_1.default.createWriteStream(outputPath);
            const archive = (0, archiver_1.default)('zip', { zlib: { level: 9 } });
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            const dbPath = path_1.default.join(dataDir, 'travel.db');
            if (fs_1.default.existsSync(dbPath))
                archive.file(dbPath, { name: 'travel.db' });
            if (fs_1.default.existsSync(uploadsDir))
                archive.directory(uploadsDir, 'uploads');
            archive.finalize();
        });
        console.log(`[Auto-Backup] Created: ${filename}`);
    }
    catch (err) {
        console.error('[Auto-Backup] Error:', err instanceof Error ? err.message : err);
        if (fs_1.default.existsSync(outputPath))
            fs_1.default.unlinkSync(outputPath);
        return;
    }
    const settings = loadSettings();
    if (settings.keep_days > 0) {
        cleanupOldBackups(settings.keep_days);
    }
}
function cleanupOldBackups(keepDays) {
    try {
        const MS_PER_DAY = 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - keepDays * MS_PER_DAY;
        const files = fs_1.default.readdirSync(backupsDir).filter(f => f.endsWith('.zip'));
        for (const file of files) {
            const filePath = path_1.default.join(backupsDir, file);
            const stat = fs_1.default.statSync(filePath);
            if (stat.birthtimeMs < cutoff) {
                fs_1.default.unlinkSync(filePath);
                console.log(`[Auto-Backup] Old backup deleted: ${file}`);
            }
        }
    }
    catch (err) {
        console.error('[Auto-Backup] Cleanup error:', err instanceof Error ? err.message : err);
    }
}
function start() {
    if (currentTask) {
        currentTask.stop();
        currentTask = null;
    }
    const settings = loadSettings();
    if (!settings.enabled) {
        console.log('[Auto-Backup] Disabled');
        return;
    }
    const expression = CRON_EXPRESSIONS[settings.interval] || CRON_EXPRESSIONS.daily;
    currentTask = node_cron_1.default.schedule(expression, runBackup);
    console.log(`[Auto-Backup] Scheduled: ${settings.interval} (${expression}), retention: ${settings.keep_days === 0 ? 'forever' : settings.keep_days + ' days'}`);
}
// Demo mode: hourly reset of demo user data
let demoTask = null;
function startDemoReset() {
    if (demoTask) {
        demoTask.stop();
        demoTask = null;
    }
    if (process.env.DEMO_MODE !== 'true')
        return;
    demoTask = node_cron_1.default.schedule('0 * * * *', () => {
        try {
            const { resetDemoUser } = require('./demo/demo-reset');
            resetDemoUser();
        }
        catch (err) {
            console.error('[Demo Reset] Error:', err instanceof Error ? err.message : err);
        }
    });
    console.log('[Demo] Hourly reset scheduled (at :00 every hour)');
}
function stop() {
    if (currentTask) {
        currentTask.stop();
        currentTask = null;
    }
    if (demoTask) {
        demoTask.stop();
        demoTask = null;
    }
}
//# sourceMappingURL=scheduler.js.map