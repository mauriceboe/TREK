"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const uuid_1 = require("uuid");
const database_1 = require("../db/database");
const auth_1 = require("../middleware/auth");
const tripAccess_1 = require("../middleware/tripAccess");
const websocket_1 = require("../websocket");
const router = express_1.default.Router({ mergeParams: true });
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const filesDir = path_1.default.join(__dirname, '../../data/uploads/files');
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => {
        if (!fs_1.default.existsSync(filesDir))
            fs_1.default.mkdirSync(filesDir, { recursive: true });
        cb(null, filesDir);
    },
    filename: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname);
        cb(null, `${(0, uuid_1.v4)()}${ext}`);
    },
});
const DEFAULT_ALLOWED_EXTENSIONS = 'jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv';
const BLOCKED_EXTENSIONS = ['.svg', '.html', '.htm', '.xml'];
function getAllowedExtensions() {
    try {
        const row = database_1.db.prepare("SELECT value FROM app_settings WHERE key = 'allowed_file_types'").get();
        return row?.value || DEFAULT_ALLOWED_EXTENSIONS;
    }
    catch {
        return DEFAULT_ALLOWED_EXTENSIONS;
    }
}
const upload = (0, multer_1.default)({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname).toLowerCase();
        if (BLOCKED_EXTENSIONS.includes(ext) || file.mimetype.includes('svg')) {
            return cb(new Error('File type not allowed'));
        }
        const allowed = getAllowedExtensions().split(',').map(e => e.trim().toLowerCase());
        const fileExt = ext.replace('.', '');
        if (allowed.includes(fileExt) || (allowed.includes('*') && !BLOCKED_EXTENSIONS.includes(ext))) {
            cb(null, true);
        }
        else {
            cb(new Error('File type not allowed'));
        }
    },
});
function verifyTripOwnership(tripId, userId) {
    return (0, database_1.canAccessTrip)(tripId, userId);
}
const FILE_SELECT = `
  SELECT f.*, r.title as reservation_title, u.username as uploaded_by_name, u.avatar as uploaded_by_avatar
  FROM trip_files f
  LEFT JOIN reservations r ON f.reservation_id = r.id
  LEFT JOIN users u ON f.uploaded_by = u.id
`;
function formatFile(file) {
    return {
        ...file,
        url: file.filename?.startsWith('files/') ? `/uploads/${file.filename}` : `/uploads/files/${file.filename}`,
        uploaded_by_avatar: file.uploaded_by_avatar
            ? `/uploads/avatars/${file.uploaded_by_avatar}`
            : null,
    };
}
// List files (excludes soft-deleted by default)
router.get('/', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const showTrash = req.query.trash === 'true';
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const where = showTrash ? 'f.trip_id = ? AND f.deleted_at IS NOT NULL' : 'f.trip_id = ? AND f.deleted_at IS NULL';
    const files = database_1.db.prepare(`${FILE_SELECT} WHERE ${where} ORDER BY f.starred DESC, f.created_at DESC`).all(tripId);
    // Get all file_links for this trip's files
    const fileIds = files.map(f => f.id);
    let linksMap = {};
    if (fileIds.length > 0) {
        const placeholders = fileIds.map(() => '?').join(',');
        const links = database_1.db.prepare(`SELECT file_id, reservation_id, place_id FROM file_links WHERE file_id IN (${placeholders})`).all(...fileIds);
        for (const link of links) {
            if (!linksMap[link.file_id])
                linksMap[link.file_id] = [];
            linksMap[link.file_id].push(link);
        }
    }
    res.json({ files: files.map(f => {
            const fileLinks = linksMap[f.id] || [];
            return {
                ...formatFile(f),
                linked_reservation_ids: fileLinks.filter(l => l.reservation_id).map(l => l.reservation_id),
                linked_place_ids: fileLinks.filter(l => l.place_id).map(l => l.place_id),
            };
        }) });
});
// Upload file
router.post('/', auth_1.authenticate, tripAccess_1.requireTripAccess, auth_1.demoUploadBlock, upload.single('file'), (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const { place_id, description, reservation_id } = req.body;
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    const result = database_1.db.prepare(`
    INSERT INTO trip_files (trip_id, place_id, reservation_id, filename, original_name, file_size, mime_type, description, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tripId, place_id || null, reservation_id || null, req.file.filename, req.file.originalname, req.file.size, req.file.mimetype, description || null, authReq.user.id);
    const file = database_1.db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(result.lastInsertRowid);
    res.status(201).json({ file: formatFile(file) });
    (0, websocket_1.broadcast)(tripId, 'file:created', { file: formatFile(file) }, req.headers['x-socket-id']);
});
// Update file metadata
router.put('/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const { description, place_id, reservation_id } = req.body;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const file = database_1.db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!file)
        return res.status(404).json({ error: 'File not found' });
    database_1.db.prepare(`
    UPDATE trip_files SET
      description = ?,
      place_id = ?,
      reservation_id = ?
    WHERE id = ?
  `).run(description !== undefined ? description : file.description, place_id !== undefined ? (place_id || null) : file.place_id, reservation_id !== undefined ? (reservation_id || null) : file.reservation_id, id);
    const updated = database_1.db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id);
    res.json({ file: formatFile(updated) });
    (0, websocket_1.broadcast)(tripId, 'file:updated', { file: formatFile(updated) }, req.headers['x-socket-id']);
});
// Toggle starred
router.patch('/:id/star', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const file = database_1.db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!file)
        return res.status(404).json({ error: 'File not found' });
    const newStarred = file.starred ? 0 : 1;
    database_1.db.prepare('UPDATE trip_files SET starred = ? WHERE id = ?').run(newStarred, id);
    const updated = database_1.db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id);
    res.json({ file: formatFile(updated) });
    (0, websocket_1.broadcast)(tripId, 'file:updated', { file: formatFile(updated) }, req.headers['x-socket-id']);
});
// Soft-delete (move to trash)
router.delete('/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const file = database_1.db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!file)
        return res.status(404).json({ error: 'File not found' });
    database_1.db.prepare('UPDATE trip_files SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    res.json({ success: true });
    (0, websocket_1.broadcast)(tripId, 'file:deleted', { fileId: Number(id) }, req.headers['x-socket-id']);
});
// Restore from trash
router.post('/:id/restore', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const file = database_1.db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ? AND deleted_at IS NOT NULL').get(id, tripId);
    if (!file)
        return res.status(404).json({ error: 'File not found in trash' });
    database_1.db.prepare('UPDATE trip_files SET deleted_at = NULL WHERE id = ?').run(id);
    const restored = database_1.db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id);
    res.json({ file: formatFile(restored) });
    (0, websocket_1.broadcast)(tripId, 'file:created', { file: formatFile(restored) }, req.headers['x-socket-id']);
});
// Permanently delete from trash
router.delete('/:id/permanent', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const file = database_1.db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ? AND deleted_at IS NOT NULL').get(id, tripId);
    if (!file)
        return res.status(404).json({ error: 'File not found in trash' });
    const filePath = path_1.default.join(filesDir, file.filename);
    if (fs_1.default.existsSync(filePath)) {
        try {
            fs_1.default.unlinkSync(filePath);
        }
        catch (e) {
            console.error('Error deleting file:', e);
        }
    }
    database_1.db.prepare('DELETE FROM trip_files WHERE id = ?').run(id);
    res.json({ success: true });
    (0, websocket_1.broadcast)(tripId, 'file:deleted', { fileId: Number(id) }, req.headers['x-socket-id']);
});
// Empty entire trash
router.delete('/trash/empty', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const trashed = database_1.db.prepare('SELECT * FROM trip_files WHERE trip_id = ? AND deleted_at IS NOT NULL').all(tripId);
    for (const file of trashed) {
        const filePath = path_1.default.join(filesDir, file.filename);
        if (fs_1.default.existsSync(filePath)) {
            try {
                fs_1.default.unlinkSync(filePath);
            }
            catch (e) {
                console.error('Error deleting file:', e);
            }
        }
    }
    database_1.db.prepare('DELETE FROM trip_files WHERE trip_id = ? AND deleted_at IS NOT NULL').run(tripId);
    res.json({ success: true, deleted: trashed.length });
});
// Link a file to a reservation (many-to-many)
router.post('/:id/link', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const { reservation_id, assignment_id, place_id } = req.body;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const file = database_1.db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!file)
        return res.status(404).json({ error: 'File not found' });
    try {
        database_1.db.prepare('INSERT OR IGNORE INTO file_links (file_id, reservation_id, assignment_id, place_id) VALUES (?, ?, ?, ?)').run(id, reservation_id || null, assignment_id || null, place_id || null);
    }
    catch { }
    const links = database_1.db.prepare('SELECT * FROM file_links WHERE file_id = ?').all(id);
    res.json({ success: true, links });
});
// Unlink a file from a reservation
router.delete('/:id/link/:linkId', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id, linkId } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    database_1.db.prepare('DELETE FROM file_links WHERE id = ? AND file_id = ?').run(linkId, id);
    res.json({ success: true });
});
// Get all links for a file
router.get('/:id/links', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const links = database_1.db.prepare(`
    SELECT fl.*, r.title as reservation_title
    FROM file_links fl
    LEFT JOIN reservations r ON fl.reservation_id = r.id
    WHERE fl.file_id = ?
  `).all(id);
    res.json({ links });
});
exports.default = router;
//# sourceMappingURL=files.js.map