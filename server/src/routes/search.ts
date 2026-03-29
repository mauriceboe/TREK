import express, { Request, Response } from 'express';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = express.Router();

router.use(authenticate);

// GET /api/search?q=<query>&limit=20
router.get('/', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user.id;
  const q = ((req.query.q as string) || '').trim();
  const limit = Math.min(parseInt((req.query.limit as string) || '20'), 100);

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }

  const like = `%${q}%`;

  // Trips the user owns or is a member of
  const trips = db.prepare(
    `SELECT t.id, t.title, t.description, t.start_date, t.end_date, t.cover_image, 'trip' as type
     FROM trips t
     LEFT JOIN trip_members tm ON tm.trip_id = t.id AND tm.user_id = ?
     WHERE (t.user_id = ? OR tm.user_id IS NOT NULL)
       AND t.is_archived = 0
       AND (t.title LIKE ? OR t.description LIKE ?)
     LIMIT ?`
  ).all(userId, userId, like, like, limit) as object[];

  // Places on trips the user can access
  const places = db.prepare(
    `SELECT p.id, p.trip_id, p.name, p.address, p.notes, p.category_id, c.name as category_name, c.icon as category_icon, 'place' as type
     FROM places p
     JOIN trips t ON t.id = p.trip_id
     LEFT JOIN trip_members tm ON tm.trip_id = t.id AND tm.user_id = ?
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE (t.user_id = ? OR tm.user_id IS NOT NULL)
       AND t.is_archived = 0
       AND (p.name LIKE ? OR p.address LIKE ? OR p.notes LIKE ?)
     LIMIT ?`
  ).all(userId, userId, like, like, like, limit) as object[];

  // Days with titles/notes
  const days = db.prepare(
    `SELECT d.id, d.trip_id, d.day_number, d.date, d.title, d.notes, 'day' as type
     FROM days d
     JOIN trips t ON t.id = d.trip_id
     LEFT JOIN trip_members tm ON tm.trip_id = t.id AND tm.user_id = ?
     WHERE (t.user_id = ? OR tm.user_id IS NOT NULL)
       AND t.is_archived = 0
       AND (d.title LIKE ? OR d.notes LIKE ?)
     LIMIT ?`
  ).all(userId, userId, like, like, limit) as object[];

  res.json({ trips, places, days, query: q });
});

export default router;
