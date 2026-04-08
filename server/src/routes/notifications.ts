import express, { Request, Response } from 'express';
import { authenticate, adminOnly } from '../middleware/auth';
import { AuthRequest } from '../types';
import { db } from '../db/database';
import {
  getPreferences,
  updatePreferences,
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
  deleteAll,
} from '../services/inAppNotifications';

const router = express.Router();

function ensureNotificationTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      notify_trip_invite INTEGER DEFAULT 1,
      notify_booking_change INTEGER DEFAULT 1,
      notify_trip_reminder INTEGER DEFAULT 1,
      notify_webhook INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      scope TEXT NOT NULL,
      target INTEGER NOT NULL,
      sender_id INTEGER,
      recipient_id INTEGER NOT NULL,
      title_key TEXT NOT NULL,
      title_params TEXT NOT NULL DEFAULT '{}',
      text_key TEXT NOT NULL,
      text_params TEXT NOT NULL DEFAULT '{}',
      positive_text_key TEXT,
      negative_text_key TEXT,
      positive_callback TEXT,
      negative_callback TEXT,
      response TEXT,
      navigate_text_key TEXT,
      navigate_target TEXT,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

router.get('/preferences', authenticate, (req: Request, res: Response) => {
  ensureNotificationTables();
  const authReq = req as AuthRequest;
  res.json({ preferences: getPreferences(authReq.user.id) });
});

router.put('/preferences', authenticate, (req: Request, res: Response) => {
  ensureNotificationTables();
  const authReq = req as AuthRequest;
  res.json({ preferences: updatePreferences(authReq.user.id, req.body || {}) });
});

router.get('/in-app', authenticate, (req: Request, res: Response) => {
  ensureNotificationTables();
  const authReq = req as AuthRequest;
  res.json(getNotifications(authReq.user.id));
});

router.get('/in-app/unread-count', authenticate, (req: Request, res: Response) => {
  ensureNotificationTables();
  const authReq = req as AuthRequest;
  res.json({ count: getUnreadCount(authReq.user.id) });
});

router.put('/in-app/read-all', authenticate, (req: Request, res: Response) => {
  ensureNotificationTables();
  const authReq = req as AuthRequest;
  markAllRead(authReq.user.id);
  res.json({ success: true });
});

router.put('/in-app/:id/read', authenticate, (req: Request, res: Response) => {
  ensureNotificationTables();
  const authReq = req as AuthRequest;
  const ok = markRead(Number(req.params.id), authReq.user.id);
  if (!ok) return res.status(404).json({ error: 'Notification not found' });
  res.json({ success: true });
});

router.delete('/in-app/all', authenticate, (req: Request, res: Response) => {
  ensureNotificationTables();
  const authReq = req as AuthRequest;
  deleteAll(authReq.user.id);
  res.json({ success: true });
});

router.delete('/in-app/:id', authenticate, (req: Request, res: Response) => {
  ensureNotificationTables();
  const authReq = req as AuthRequest;
  const ok = deleteNotification(Number(req.params.id), authReq.user.id);
  if (!ok) return res.status(404).json({ error: 'Notification not found' });
  res.json({ success: true });
});

router.post('/test-smtp', authenticate, adminOnly, (_req: Request, res: Response) => {
  res.json({ success: true });
});

router.post('/test-webhook', authenticate, adminOnly, (_req: Request, res: Response) => {
  res.json({ success: true });
});

export default router;
