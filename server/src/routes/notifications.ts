import express, { Request, Response } from 'express';
import { db } from '../db/database';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import { testSmtp, testWebhook } from '../services/notifications';

const router = express.Router();

// Get user's notification preferences
router.get('/preferences', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  let prefs = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(authReq.user.id);
  if (!prefs) {
    db.prepare('INSERT INTO notification_preferences (user_id) VALUES (?)').run(authReq.user.id);
    prefs = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(authReq.user.id);
  }
  res.json({ preferences: prefs });
});

// Update user's notification preferences
router.put('/preferences', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { notify_trip_invite, notify_booking_change, notify_trip_reminder, notify_webhook } = req.body;

  // Ensure row exists
  const existing = db.prepare('SELECT id FROM notification_preferences WHERE user_id = ?').get(authReq.user.id);
  if (!existing) {
    db.prepare('INSERT INTO notification_preferences (user_id) VALUES (?)').run(authReq.user.id);
  }

  db.prepare(`UPDATE notification_preferences SET
    notify_trip_invite = COALESCE(?, notify_trip_invite),
    notify_booking_change = COALESCE(?, notify_booking_change),
    notify_trip_reminder = COALESCE(?, notify_trip_reminder),
    notify_webhook = COALESCE(?, notify_webhook)
    WHERE user_id = ?`).run(
    notify_trip_invite !== undefined ? (notify_trip_invite ? 1 : 0) : null,
    notify_booking_change !== undefined ? (notify_booking_change ? 1 : 0) : null,
    notify_trip_reminder !== undefined ? (notify_trip_reminder ? 1 : 0) : null,
    notify_webhook !== undefined ? (notify_webhook ? 1 : 0) : null,
    authReq.user.id
  );

  const prefs = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(authReq.user.id);
  res.json({ preferences: prefs });
});

// Admin: test SMTP configuration
router.post('/test-smtp', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (authReq.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { email } = req.body;
  const result = await testSmtp(email || authReq.user.email);
  res.json(result);
});

// Admin: test webhook configuration
router.post('/test-webhook', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (authReq.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const result = await testWebhook();
  res.json(result);
});

export default router;
