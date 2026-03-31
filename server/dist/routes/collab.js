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
const websocket_1 = require("../websocket");
const validate_1 = require("../middleware/validate");
const MAX_NOTE_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const filesDir = path_1.default.join(__dirname, '../../data/uploads/files');
const noteUpload = (0, multer_1.default)({
    storage: multer_1.default.diskStorage({
        destination: (_req, _file, cb) => { if (!fs_1.default.existsSync(filesDir))
            fs_1.default.mkdirSync(filesDir, { recursive: true }); cb(null, filesDir); },
        filename: (_req, file, cb) => { cb(null, `${(0, uuid_1.v4)()}${path_1.default.extname(file.originalname)}`); },
    }),
    limits: { fileSize: MAX_NOTE_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname).toLowerCase();
        const BLOCKED = ['.svg', '.html', '.htm', '.xml', '.xhtml', '.js', '.jsx', '.ts', '.exe', '.bat', '.sh', '.cmd', '.msi', '.dll', '.com', '.vbs', '.ps1', '.php'];
        if (BLOCKED.includes(ext) || file.mimetype.includes('svg') || file.mimetype.includes('html') || file.mimetype.includes('javascript')) {
            return cb(new Error('File type not allowed'));
        }
        cb(null, true);
    },
});
const router = express_1.default.Router({ mergeParams: true });
function verifyTripAccess(tripId, userId) {
    return (0, database_1.canAccessTrip)(tripId, userId);
}
function avatarUrl(user) {
    return user.avatar ? `/uploads/avatars/${user.avatar}` : null;
}
function formatNote(note) {
    const attachments = database_1.db.prepare('SELECT id, filename, original_name, file_size, mime_type FROM trip_files WHERE note_id = ?').all(note.id);
    return {
        ...note,
        avatar_url: avatarUrl(note),
        attachments: attachments.map(a => ({ ...a, url: `/uploads/${a.filename}` })),
    };
}
function loadReactions(messageId) {
    return database_1.db.prepare(`
    SELECT r.emoji, r.user_id, u.username
    FROM collab_message_reactions r
    JOIN users u ON r.user_id = u.id
    WHERE r.message_id = ?
  `).all(messageId);
}
function groupReactions(reactions) {
    const map = {};
    for (const r of reactions) {
        if (!map[r.emoji])
            map[r.emoji] = [];
        map[r.emoji].push({ user_id: r.user_id, username: r.username });
    }
    return Object.entries(map).map(([emoji, users]) => ({ emoji, users, count: users.length }));
}
function formatMessage(msg, reactions) {
    return { ...msg, user_avatar: avatarUrl(msg), avatar_url: avatarUrl(msg), reactions: reactions || [] };
}
router.get('/notes', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    if (!verifyTripAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const notes = database_1.db.prepare(`
    SELECT n.*, u.username, u.avatar
    FROM collab_notes n
    JOIN users u ON n.user_id = u.id
    WHERE n.trip_id = ?
    ORDER BY n.pinned DESC, n.updated_at DESC
  `).all(tripId);
    res.json({ notes: notes.map(formatNote) });
});
router.post('/notes', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const { title, content, category, color, website } = req.body;
    if (!verifyTripAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    if (!title)
        return res.status(400).json({ error: 'Title is required' });
    const result = database_1.db.prepare(`
    INSERT INTO collab_notes (trip_id, user_id, title, content, category, color, website)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(tripId, authReq.user.id, title, content || null, category || 'General', color || '#6366f1', website || null);
    const note = database_1.db.prepare(`
    SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?
  `).get(result.lastInsertRowid);
    const formatted = formatNote(note);
    res.status(201).json({ note: formatted });
    (0, websocket_1.broadcast)(tripId, 'collab:note:created', { note: formatted }, req.headers['x-socket-id']);
});
router.put('/notes/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const { title, content, category, color, pinned, website } = req.body;
    if (!verifyTripAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const existing = database_1.db.prepare('SELECT * FROM collab_notes WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!existing)
        return res.status(404).json({ error: 'Note not found' });
    database_1.db.prepare(`
    UPDATE collab_notes SET
      title = COALESCE(?, title),
      content = CASE WHEN ? THEN ? ELSE content END,
      category = COALESCE(?, category),
      color = COALESCE(?, color),
      pinned = CASE WHEN ? IS NOT NULL THEN ? ELSE pinned END,
      website = CASE WHEN ? THEN ? ELSE website END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title || null, content !== undefined ? 1 : 0, content !== undefined ? content : null, category || null, color || null, pinned !== undefined ? 1 : null, pinned ? 1 : 0, website !== undefined ? 1 : 0, website !== undefined ? website : null, id);
    const note = database_1.db.prepare(`
    SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?
  `).get(id);
    const formatted = formatNote(note);
    res.json({ note: formatted });
    (0, websocket_1.broadcast)(tripId, 'collab:note:updated', { note: formatted }, req.headers['x-socket-id']);
});
router.delete('/notes/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    if (!verifyTripAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const existing = database_1.db.prepare('SELECT id FROM collab_notes WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!existing)
        return res.status(404).json({ error: 'Note not found' });
    const noteFiles = database_1.db.prepare('SELECT id, filename FROM trip_files WHERE note_id = ?').all(id);
    for (const f of noteFiles) {
        const filePath = path_1.default.join(__dirname, '../../data/uploads', f.filename);
        try {
            fs_1.default.unlinkSync(filePath);
        }
        catch { }
    }
    database_1.db.prepare('DELETE FROM trip_files WHERE note_id = ?').run(id);
    database_1.db.prepare('DELETE FROM collab_notes WHERE id = ?').run(id);
    res.json({ success: true });
    (0, websocket_1.broadcast)(tripId, 'collab:note:deleted', { noteId: Number(id) }, req.headers['x-socket-id']);
});
router.post('/notes/:id/files', auth_1.authenticate, noteUpload.single('file'), (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    if (!verifyTripAccess(Number(tripId), authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    if (!req.file)
        return res.status(400).json({ error: 'No file uploaded' });
    const note = database_1.db.prepare('SELECT id FROM collab_notes WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!note)
        return res.status(404).json({ error: 'Note not found' });
    const result = database_1.db.prepare('INSERT INTO trip_files (trip_id, note_id, filename, original_name, file_size, mime_type) VALUES (?, ?, ?, ?, ?, ?)').run(tripId, id, `files/${req.file.filename}`, req.file.originalname, req.file.size, req.file.mimetype);
    const file = database_1.db.prepare('SELECT * FROM trip_files WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ file: { ...file, url: `/uploads/${file.filename}` } });
    (0, websocket_1.broadcast)(Number(tripId), 'collab:note:updated', { note: formatNote(database_1.db.prepare('SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?').get(id)) }, req.headers['x-socket-id']);
});
router.delete('/notes/:id/files/:fileId', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id, fileId } = req.params;
    if (!verifyTripAccess(Number(tripId), authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const file = database_1.db.prepare('SELECT * FROM trip_files WHERE id = ? AND note_id = ?').get(fileId, id);
    if (!file)
        return res.status(404).json({ error: 'File not found' });
    const filePath = path_1.default.join(__dirname, '../../data/uploads', file.filename);
    try {
        fs_1.default.unlinkSync(filePath);
    }
    catch { }
    database_1.db.prepare('DELETE FROM trip_files WHERE id = ?').run(fileId);
    res.json({ success: true });
    (0, websocket_1.broadcast)(Number(tripId), 'collab:note:updated', { note: formatNote(database_1.db.prepare('SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?').get(id)) }, req.headers['x-socket-id']);
});
function getPollWithVotes(pollId) {
    const poll = database_1.db.prepare(`
    SELECT p.*, u.username, u.avatar
    FROM collab_polls p
    JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `).get(pollId);
    if (!poll)
        return null;
    const options = JSON.parse(poll.options);
    const votes = database_1.db.prepare(`
    SELECT v.option_index, v.user_id, u.username, u.avatar
    FROM collab_poll_votes v
    JOIN users u ON v.user_id = u.id
    WHERE v.poll_id = ?
  `).all(pollId);
    const formattedOptions = options.map((label, idx) => ({
        label: typeof label === 'string' ? label : label.label || label,
        voters: votes
            .filter(v => v.option_index === idx)
            .map(v => ({ id: v.user_id, user_id: v.user_id, username: v.username, avatar: v.avatar, avatar_url: avatarUrl(v) })),
    }));
    return {
        ...poll,
        avatar_url: avatarUrl(poll),
        options: formattedOptions,
        is_closed: !!poll.closed,
        multiple_choice: !!poll.multiple,
    };
}
router.get('/polls', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    if (!verifyTripAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const rows = database_1.db.prepare(`
    SELECT id FROM collab_polls WHERE trip_id = ? ORDER BY created_at DESC
  `).all(tripId);
    const polls = rows.map(row => getPollWithVotes(row.id)).filter(Boolean);
    res.json({ polls });
});
router.post('/polls', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const { question, options, multiple, multiple_choice, deadline } = req.body;
    if (!verifyTripAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    if (!question)
        return res.status(400).json({ error: 'Question is required' });
    if (!Array.isArray(options) || options.length < 2) {
        return res.status(400).json({ error: 'At least 2 options are required' });
    }
    const isMultiple = multiple || multiple_choice;
    const result = database_1.db.prepare(`
    INSERT INTO collab_polls (trip_id, user_id, question, options, multiple, deadline)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tripId, authReq.user.id, question, JSON.stringify(options), isMultiple ? 1 : 0, deadline || null);
    const poll = getPollWithVotes(result.lastInsertRowid);
    res.status(201).json({ poll });
    (0, websocket_1.broadcast)(tripId, 'collab:poll:created', { poll }, req.headers['x-socket-id']);
});
router.post('/polls/:id/vote', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const { option_index } = req.body;
    if (!verifyTripAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const poll = database_1.db.prepare('SELECT * FROM collab_polls WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!poll)
        return res.status(404).json({ error: 'Poll not found' });
    if (poll.closed)
        return res.status(400).json({ error: 'Poll is closed' });
    const options = JSON.parse(poll.options);
    if (option_index < 0 || option_index >= options.length) {
        return res.status(400).json({ error: 'Invalid option index' });
    }
    const existingVote = database_1.db.prepare('SELECT id FROM collab_poll_votes WHERE poll_id = ? AND user_id = ? AND option_index = ?').get(id, authReq.user.id, option_index);
    if (existingVote) {
        database_1.db.prepare('DELETE FROM collab_poll_votes WHERE id = ?').run(existingVote.id);
    }
    else {
        if (!poll.multiple) {
            database_1.db.prepare('DELETE FROM collab_poll_votes WHERE poll_id = ? AND user_id = ?').run(id, authReq.user.id);
        }
        database_1.db.prepare('INSERT INTO collab_poll_votes (poll_id, user_id, option_index) VALUES (?, ?, ?)').run(id, authReq.user.id, option_index);
    }
    const updatedPoll = getPollWithVotes(id);
    res.json({ poll: updatedPoll });
    (0, websocket_1.broadcast)(tripId, 'collab:poll:voted', { poll: updatedPoll }, req.headers['x-socket-id']);
});
router.put('/polls/:id/close', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    if (!verifyTripAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const poll = database_1.db.prepare('SELECT * FROM collab_polls WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!poll)
        return res.status(404).json({ error: 'Poll not found' });
    database_1.db.prepare('UPDATE collab_polls SET closed = 1 WHERE id = ?').run(id);
    const updatedPoll = getPollWithVotes(id);
    res.json({ poll: updatedPoll });
    (0, websocket_1.broadcast)(tripId, 'collab:poll:closed', { poll: updatedPoll }, req.headers['x-socket-id']);
});
router.delete('/polls/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    if (!verifyTripAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const poll = database_1.db.prepare('SELECT id FROM collab_polls WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!poll)
        return res.status(404).json({ error: 'Poll not found' });
    database_1.db.prepare('DELETE FROM collab_polls WHERE id = ?').run(id);
    res.json({ success: true });
    (0, websocket_1.broadcast)(tripId, 'collab:poll:deleted', { pollId: Number(id) }, req.headers['x-socket-id']);
});
router.get('/messages', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const { before } = req.query;
    if (!verifyTripAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const query = `
    SELECT m.*, u.username, u.avatar,
      rm.text AS reply_text, ru.username AS reply_username
    FROM collab_messages m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN collab_messages rm ON m.reply_to = rm.id
    LEFT JOIN users ru ON rm.user_id = ru.id
    WHERE m.trip_id = ?${before ? ' AND m.id < ?' : ''}
    ORDER BY m.id DESC
    LIMIT 100
  `;
    const messages = before
        ? database_1.db.prepare(query).all(tripId, before)
        : database_1.db.prepare(query).all(tripId);
    messages.reverse();
    const msgIds = messages.map(m => m.id);
    const reactionsByMsg = {};
    if (msgIds.length > 0) {
        const allReactions = database_1.db.prepare(`
      SELECT r.message_id, r.emoji, r.user_id, u.username
      FROM collab_message_reactions r
      JOIN users u ON r.user_id = u.id
      WHERE r.message_id IN (${msgIds.map(() => '?').join(',')})
    `).all(...msgIds);
        for (const r of allReactions) {
            if (!reactionsByMsg[r.message_id])
                reactionsByMsg[r.message_id] = [];
            reactionsByMsg[r.message_id].push(r);
        }
    }
    res.json({ messages: messages.map(m => formatMessage(m, groupReactions(reactionsByMsg[m.id] || []))) });
});
router.post('/messages', auth_1.authenticate, (0, validate_1.validateStringLengths)({ text: 5000 }), (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const { text, reply_to } = req.body;
    if (!verifyTripAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    if (!text || !text.trim())
        return res.status(400).json({ error: 'Message text is required' });
    if (reply_to) {
        const replyMsg = database_1.db.prepare('SELECT id FROM collab_messages WHERE id = ? AND trip_id = ?').get(reply_to, tripId);
        if (!replyMsg)
            return res.status(400).json({ error: 'Reply target message not found' });
    }
    const result = database_1.db.prepare(`
    INSERT INTO collab_messages (trip_id, user_id, text, reply_to) VALUES (?, ?, ?, ?)
  `).run(tripId, authReq.user.id, text.trim(), reply_to || null);
    const message = database_1.db.prepare(`
    SELECT m.*, u.username, u.avatar,
      rm.text AS reply_text, ru.username AS reply_username
    FROM collab_messages m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN collab_messages rm ON m.reply_to = rm.id
    LEFT JOIN users ru ON rm.user_id = ru.id
    WHERE m.id = ?
  `).get(result.lastInsertRowid);
    const formatted = formatMessage(message);
    res.status(201).json({ message: formatted });
    (0, websocket_1.broadcast)(tripId, 'collab:message:created', { message: formatted }, req.headers['x-socket-id']);
});
router.post('/messages/:id/react', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const { emoji } = req.body;
    if (!verifyTripAccess(Number(tripId), authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    if (!emoji)
        return res.status(400).json({ error: 'Emoji is required' });
    const msg = database_1.db.prepare('SELECT id FROM collab_messages WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!msg)
        return res.status(404).json({ error: 'Message not found' });
    const existing = database_1.db.prepare('SELECT id FROM collab_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(id, authReq.user.id, emoji);
    if (existing) {
        database_1.db.prepare('DELETE FROM collab_message_reactions WHERE id = ?').run(existing.id);
    }
    else {
        database_1.db.prepare('INSERT INTO collab_message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(id, authReq.user.id, emoji);
    }
    const reactions = groupReactions(loadReactions(id));
    res.json({ reactions });
    (0, websocket_1.broadcast)(Number(tripId), 'collab:message:reacted', { messageId: Number(id), reactions }, req.headers['x-socket-id']);
});
router.delete('/messages/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    if (!verifyTripAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const message = database_1.db.prepare('SELECT * FROM collab_messages WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!message)
        return res.status(404).json({ error: 'Message not found' });
    if (Number(message.user_id) !== Number(authReq.user.id))
        return res.status(403).json({ error: 'You can only delete your own messages' });
    database_1.db.prepare('UPDATE collab_messages SET deleted = 1 WHERE id = ?').run(id);
    res.json({ success: true });
    (0, websocket_1.broadcast)(tripId, 'collab:message:deleted', { messageId: Number(id), username: message.username || authReq.user.username }, req.headers['x-socket-id']);
});
router.get('/link-preview', auth_1.authenticate, async (req, res) => {
    const { url } = req.query;
    if (!url)
        return res.status(400).json({ error: 'URL is required' });
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return res.status(400).json({ error: 'Only HTTP(S) URLs are allowed' });
        }
        const hostname = parsed.hostname.toLowerCase();
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
            hostname === '0.0.0.0' || hostname.endsWith('.local') || hostname.endsWith('.internal') ||
            /^10\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || /^192\.168\./.test(hostname) ||
            /^169\.254\./.test(hostname) || hostname === '[::1]' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80')) {
            return res.status(400).json({ error: 'Private/internal URLs are not allowed' });
        }
        const dns = require('dns').promises;
        let resolved;
        try {
            resolved = await dns.lookup(parsed.hostname);
        }
        catch {
            return res.status(400).json({ error: 'Could not resolve hostname' });
        }
        const ip = resolved.address;
        if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|::1|::ffff:(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.))/.test(ip)) {
            return res.status(400).json({ error: 'Private/internal URLs are not allowed' });
        }
        const nodeFetch = require('node-fetch');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        nodeFetch(url, { redirect: 'error',
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NOMAD/1.0; +https://github.com/mauriceboe/NOMAD)' },
        })
            .then((r) => {
            clearTimeout(timeout);
            if (!r.ok)
                throw new Error('Fetch failed');
            return r.text();
        })
            .then((html) => {
            const get = (prop) => {
                const m = html.match(new RegExp(`<meta[^>]*property=["']og:${prop}["'][^>]*content=["']([^"']*)["']`, 'i'))
                    || html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:${prop}["']`, 'i'));
                return m ? m[1] : null;
            };
            const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);
            const descMeta = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
                || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
            res.json({
                title: get('title') || (titleTag ? titleTag[1].trim() : null),
                description: get('description') || (descMeta ? descMeta[1].trim() : null),
                image: get('image') || null,
                site_name: get('site_name') || null,
                url,
            });
        })
            .catch(() => {
            clearTimeout(timeout);
            res.json({ title: null, description: null, image: null, url });
        });
    }
    catch {
        res.json({ title: null, description: null, image: null, url });
    }
});
exports.default = router;
//# sourceMappingURL=collab.js.map