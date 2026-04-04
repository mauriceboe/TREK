import { db } from '../db/database';

export function getPreferences(userId: number) {
  let prefs = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(userId);
  if (!prefs) {
    db.prepare('INSERT INTO notification_preferences (user_id) VALUES (?)').run(userId);
    prefs = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(userId);
  }
  return prefs;
}

export function updatePreferences(
  userId: number,
  fields: {
    notify_trip_invite?: boolean;
    notify_booking_change?: boolean;
    notify_trip_reminder?: boolean;
    notify_webhook?: boolean;
  }
) {
  const existing = db.prepare('SELECT id FROM notification_preferences WHERE user_id = ?').get(userId);
  if (!existing) {
    db.prepare('INSERT INTO notification_preferences (user_id) VALUES (?)').run(userId);
  }

  db.prepare(`UPDATE notification_preferences SET
    notify_trip_invite = COALESCE(?, notify_trip_invite),
    notify_booking_change = COALESCE(?, notify_booking_change),
    notify_trip_reminder = COALESCE(?, notify_trip_reminder),
    notify_webhook = COALESCE(?, notify_webhook)
    WHERE user_id = ?`).run(
    fields.notify_trip_invite !== undefined ? (fields.notify_trip_invite ? 1 : 0) : null,
    fields.notify_booking_change !== undefined ? (fields.notify_booking_change ? 1 : 0) : null,
    fields.notify_trip_reminder !== undefined ? (fields.notify_trip_reminder ? 1 : 0) : null,
    fields.notify_webhook !== undefined ? (fields.notify_webhook ? 1 : 0) : null,
    userId
  );

  return db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(userId);
}
