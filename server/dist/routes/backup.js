"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const archiver_1 = __importDefault(require("archiver"));
const unzipper_1 = __importDefault(require("unzipper"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const auth_1 = require("../middleware/auth");
const scheduler = __importStar(require("../scheduler"));
const database_1 = require("../db/database");
const router = express_1.default.Router();
router.use(auth_1.authenticate, auth_1.adminOnly);
const BACKUP_RATE_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_BACKUP_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB
const backupAttempts = new Map();
function backupRateLimiter(maxAttempts, windowMs) {
    return (req, res, next) => {
        const key = req.ip || 'unknown';
        const now = Date.now();
        const record = backupAttempts.get(key);
        if (record && record.count >= maxAttempts && now - record.first < windowMs) {
            return res.status(429).json({ error: 'Too many backup requests. Please try again later.' });
        }
        if (!record || now - record.first >= windowMs) {
            backupAttempts.set(key, { count: 1, first: now });
        }
        else {
            record.count++;
        }
        next();
    };
}
const dataDir = path_1.default.join(__dirname, '../../data');
const backupsDir = path_1.default.join(dataDir, 'backups');
const uploadsDir = path_1.default.join(__dirname, '../../data/uploads');
function ensureBackupsDir() {
    if (!fs_1.default.existsSync(backupsDir))
        fs_1.default.mkdirSync(backupsDir, { recursive: true });
}
function formatSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
router.get('/list', (_req, res) => {
    ensureBackupsDir();
    try {
        const files = fs_1.default.readdirSync(backupsDir)
            .filter(f => f.endsWith('.zip'))
            .map(filename => {
            const filePath = path_1.default.join(backupsDir, filename);
            const stat = fs_1.default.statSync(filePath);
            return {
                filename,
                size: stat.size,
                sizeText: formatSize(stat.size),
                created_at: stat.birthtime.toISOString(),
            };
        })
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        res.json({ backups: files });
    }
    catch (err) {
        res.status(500).json({ error: 'Error loading backups' });
    }
});
router.post('/create', backupRateLimiter(3, BACKUP_RATE_WINDOW), async (_req, res) => {
    ensureBackupsDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `backup-${timestamp}.zip`;
    const outputPath = path_1.default.join(backupsDir, filename);
    try {
        try {
            database_1.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        }
        catch (e) { }
        await new Promise((resolve, reject) => {
            const output = fs_1.default.createWriteStream(outputPath);
            const archive = (0, archiver_1.default)('zip', { zlib: { level: 9 } });
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            const dbPath = path_1.default.join(dataDir, 'travel.db');
            if (fs_1.default.existsSync(dbPath)) {
                archive.file(dbPath, { name: 'travel.db' });
            }
            if (fs_1.default.existsSync(uploadsDir)) {
                archive.directory(uploadsDir, 'uploads');
            }
            archive.finalize();
        });
        const stat = fs_1.default.statSync(outputPath);
        res.json({
            success: true,
            backup: {
                filename,
                size: stat.size,
                sizeText: formatSize(stat.size),
                created_at: stat.birthtime.toISOString(),
            }
        });
    }
    catch (err) {
        console.error('Backup error:', err);
        if (fs_1.default.existsSync(outputPath))
            fs_1.default.unlinkSync(outputPath);
        res.status(500).json({ error: 'Error creating backup' });
    }
});
router.get('/download/:filename', (req, res) => {
    const { filename } = req.params;
    if (!/^backup-[\w\-]+\.zip$/.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path_1.default.join(backupsDir, filename);
    if (!fs_1.default.existsSync(filePath)) {
        return res.status(404).json({ error: 'Backup not found' });
    }
    res.download(filePath, filename);
});
async function restoreFromZip(zipPath, res) {
    const extractDir = path_1.default.join(dataDir, `restore-${Date.now()}`);
    try {
        await fs_1.default.createReadStream(zipPath)
            .pipe(unzipper_1.default.Extract({ path: extractDir }))
            .promise();
        const extractedDb = path_1.default.join(extractDir, 'travel.db');
        if (!fs_1.default.existsSync(extractedDb)) {
            fs_1.default.rmSync(extractDir, { recursive: true, force: true });
            return res.status(400).json({ error: 'Invalid backup: travel.db not found' });
        }
        (0, database_1.closeDb)();
        try {
            const dbDest = path_1.default.join(dataDir, 'travel.db');
            for (const ext of ['', '-wal', '-shm']) {
                try {
                    fs_1.default.unlinkSync(dbDest + ext);
                }
                catch (e) { }
            }
            fs_1.default.copyFileSync(extractedDb, dbDest);
            const extractedUploads = path_1.default.join(extractDir, 'uploads');
            if (fs_1.default.existsSync(extractedUploads)) {
                for (const sub of fs_1.default.readdirSync(uploadsDir)) {
                    const subPath = path_1.default.join(uploadsDir, sub);
                    if (fs_1.default.statSync(subPath).isDirectory()) {
                        for (const file of fs_1.default.readdirSync(subPath)) {
                            try {
                                fs_1.default.unlinkSync(path_1.default.join(subPath, file));
                            }
                            catch (e) { }
                        }
                    }
                }
                fs_1.default.cpSync(extractedUploads, uploadsDir, { recursive: true, force: true });
            }
        }
        finally {
            (0, database_1.reinitialize)();
        }
        fs_1.default.rmSync(extractDir, { recursive: true, force: true });
        res.json({ success: true });
    }
    catch (err) {
        console.error('Restore error:', err);
        if (fs_1.default.existsSync(extractDir))
            fs_1.default.rmSync(extractDir, { recursive: true, force: true });
        if (!res.headersSent)
            res.status(500).json({ error: 'Error restoring backup' });
    }
}
router.post('/restore/:filename', async (req, res) => {
    const { filename } = req.params;
    if (!/^backup-[\w\-]+\.zip$/.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const zipPath = path_1.default.join(backupsDir, filename);
    if (!fs_1.default.existsSync(zipPath)) {
        return res.status(404).json({ error: 'Backup not found' });
    }
    await restoreFromZip(zipPath, res);
});
const uploadTmp = (0, multer_1.default)({
    dest: path_1.default.join(dataDir, 'tmp/'),
    fileFilter: (_req, file, cb) => {
        if (file.originalname.endsWith('.zip'))
            cb(null, true);
        else
            cb(new Error('Only ZIP files allowed'));
    },
    limits: { fileSize: MAX_BACKUP_UPLOAD_SIZE },
});
router.post('/upload-restore', uploadTmp.single('backup'), async (req, res) => {
    if (!req.file)
        return res.status(400).json({ error: 'No file uploaded' });
    const zipPath = req.file.path;
    await restoreFromZip(zipPath, res);
    if (fs_1.default.existsSync(zipPath))
        fs_1.default.unlinkSync(zipPath);
});
router.get('/auto-settings', (_req, res) => {
    try {
        res.json({ settings: scheduler.loadSettings() });
    }
    catch (err) {
        console.error('[backup] GET auto-settings:', err);
        res.status(500).json({ error: 'Could not load backup settings' });
    }
});
function parseAutoBackupBody(body) {
    const enabled = body.enabled === true || body.enabled === 'true' || body.enabled === 1;
    const rawInterval = body.interval;
    const interval = typeof rawInterval === 'string' && scheduler.VALID_INTERVALS.includes(rawInterval)
        ? rawInterval
        : 'daily';
    const rawKeep = body.keep_days;
    let keepNum;
    if (typeof rawKeep === 'number' && Number.isFinite(rawKeep)) {
        keepNum = Math.floor(rawKeep);
    }
    else if (typeof rawKeep === 'string' && rawKeep.trim() !== '') {
        keepNum = parseInt(rawKeep, 10);
    }
    else {
        keepNum = NaN;
    }
    const keep_days = Number.isFinite(keepNum) && keepNum >= 0 ? keepNum : 7;
    return { enabled, interval, keep_days };
}
router.put('/auto-settings', (req, res) => {
    try {
        const settings = parseAutoBackupBody((req.body || {}));
        scheduler.saveSettings(settings);
        scheduler.start();
        res.json({ settings });
    }
    catch (err) {
        console.error('[backup] PUT auto-settings:', err);
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({
            error: 'Could not save auto-backup settings',
            detail: process.env.NODE_ENV !== 'production' ? msg : undefined,
        });
    }
});
router.delete('/:filename', (req, res) => {
    const { filename } = req.params;
    if (!/^backup-[\w\-]+\.zip$/.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path_1.default.join(backupsDir, filename);
    if (!fs_1.default.existsSync(filePath)) {
        return res.status(404).json({ error: 'Backup not found' });
    }
    fs_1.default.unlinkSync(filePath);
    res.json({ success: true });
});
exports.default = router;
//# sourceMappingURL=backup.js.map