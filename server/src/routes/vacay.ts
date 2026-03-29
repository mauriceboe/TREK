import express, { Request, Response } from 'express';
import { db } from '../db/database';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';

interface VacayPlan {
  id: number;
  owner_id: number;
  block_weekends: number;
  holidays_enabled: number;
  holidays_region: string | null;
  company_holidays_enabled: number;
  carry_over_enabled: number;
}

interface VacayUserYear {
  user_id: number;
  plan_id: number;
  year: number;
  vacation_days: number;
  carried_over: number;
}

interface VacayUser {
  id: number;
  username: string;
  email: string;
}

interface VacayPlanMember {
  id: number;
  plan_id: number;
  user_id: number;
  status: string;
  created_at?: string;
}

interface Holiday {
  date: string;
  localName?: string;
  name?: string;
  global?: boolean;
  counties?: string[] | null;
}

interface VacayHolidayCalendar {
  id: number;
  plan_id: number;
  region: string;
  label: string | null;
  color: string;
  sort_order: number;
}

const holidayCache = new Map<string, { data: unknown; time: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

async function applyHolidayCalendars(planId: number): Promise<void> {
  const plan = db.prepare('SELECT holidays_enabled FROM vacay_plans WHERE id = ?').get(planId) as { holidays_enabled: number } | undefined;
  if (!plan?.holidays_enabled) return;
  const calendars = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ? ORDER BY sort_order, id').all(planId) as VacayHolidayCalendar[];
  if (calendars.length === 0) return;
  const years = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ?').all(planId) as { year: number }[];
  for (const cal of calendars) {
    const country = cal.region.split('-')[0];
    const region = cal.region.includes('-') ? cal.region : null;
    for (const { year } of years) {
      try {
        const cacheKey = `${year}-${country}`;
        let holidays = holidayCache.get(cacheKey)?.data as Holiday[] | undefined;
        if (!holidays) {
          const resp = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
          holidays = await resp.json() as Holiday[];
          holidayCache.set(cacheKey, { data: holidays, time: Date.now() });
        }
        const hasRegions = holidays.some((h: Holiday) => h.counties && h.counties.length > 0);
        if (hasRegions && !region) continue;
        for (const h of holidays) {
          if (h.global || !h.counties || (region && h.counties.includes(region))) {
            db.prepare('DELETE FROM vacay_entries WHERE plan_id = ? AND date = ?').run(planId, h.date);
            db.prepare('DELETE FROM vacay_company_holidays WHERE plan_id = ? AND date = ?').run(planId, h.date);
          }
        }
      } catch { /* API error, skip */ }
    }
  }
}

async function migrateHolidayCalendars(planId: number, plan: VacayPlan): Promise<void> {
  const existing = db.prepare('SELECT id FROM vacay_holiday_calendars WHERE plan_id = ?').get(planId);
  if (existing) return;
  if (plan.holidays_enabled && plan.holidays_region) {
    db.prepare(
      'INSERT INTO vacay_holiday_calendars (plan_id, region, label, color, sort_order) VALUES (?, ?, NULL, ?, 0)'
    ).run(planId, plan.holidays_region, '#fecaca');
  }
}

const router = express.Router();
router.use(authenticate);

function notifyPlanUsers(planId: number, excludeSid: string | undefined, event = 'vacay:update') {
  try {
    const { broadcastToUser } = require('../websocket');
    const plan = db.prepare('SELECT owner_id FROM vacay_plans WHERE id = ?').get(planId) as { owner_id: number } | undefined;
    if (!plan) return;
    const userIds = [plan.owner_id];
    const members = db.prepare("SELECT user_id FROM vacay_plan_members WHERE plan_id = ? AND status = 'accepted'").all(planId) as { user_id: number }[];
    members.forEach(m => userIds.push(m.user_id));
    userIds.forEach(id => broadcastToUser(id, { type: event }, excludeSid));
  } catch { /* */ }
}

function getOwnPlan(userId: number) {
  let plan = db.prepare('SELECT * FROM vacay_plans WHERE owner_id = ?').get(userId) as VacayPlan | undefined;
  if (!plan) {
    db.prepare('INSERT INTO vacay_plans (owner_id) VALUES (?)').run(userId);
    plan = db.prepare('SELECT * FROM vacay_plans WHERE owner_id = ?').get(userId) as VacayPlan;
    const yr = new Date().getFullYear();
    db.prepare('INSERT OR IGNORE INTO vacay_years (plan_id, year) VALUES (?, ?)').run(plan.id, yr);
    db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, 0)').run(userId, plan.id, yr);
    db.prepare('INSERT OR IGNORE INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)').run(userId, plan.id, '#6366f1');
  }
  return plan;
}

function getActivePlan(userId: number) {
  const membership = db.prepare(`
    SELECT plan_id FROM vacay_plan_members WHERE user_id = ? AND status = 'accepted'
  `).get(userId) as { plan_id: number } | undefined;
  if (membership) {
    return db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(membership.plan_id) as VacayPlan;
  }
  return getOwnPlan(userId);
}

function getActivePlanId(userId: number): number {
  return getActivePlan(userId).id;
}

function getPlanUsers(planId: number) {
  const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
  if (!plan) return [];
  const owner = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(plan.owner_id) as VacayUser;
  const members = db.prepare(`
    SELECT u.id, u.username, u.email FROM vacay_plan_members m
    JOIN users u ON m.user_id = u.id
    WHERE m.plan_id = ? AND m.status = 'accepted'
  `).all(planId) as VacayUser[];
  return [owner, ...members];
}

router.get('/plan', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const plan = getActivePlan(authReq.user.id);
  const activePlanId = plan.id;

  const users = getPlanUsers(activePlanId).map(u => {
    const colorRow = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(u.id, activePlanId) as { color: string } | undefined;
    return { ...u, color: colorRow?.color || '#6366f1' };
  });

  const pendingInvites = db.prepare(`
    SELECT m.id, m.user_id, u.username, u.email, m.created_at
    FROM vacay_plan_members m JOIN users u ON m.user_id = u.id
    WHERE m.plan_id = ? AND m.status = 'pending'
  `).all(activePlanId);

  const incomingInvites = db.prepare(`
    SELECT m.id, m.plan_id, u.username, u.email, m.created_at
    FROM vacay_plan_members m
    JOIN vacay_plans p ON m.plan_id = p.id
    JOIN users u ON p.owner_id = u.id
    WHERE m.user_id = ? AND m.status = 'pending'
  `).all(authReq.user.id);

  const holidayCalendars = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ? ORDER BY sort_order, id').all(activePlanId) as VacayHolidayCalendar[];

  res.json({
    plan: {
      ...plan,
      block_weekends: !!plan.block_weekends,
      holidays_enabled: !!plan.holidays_enabled,
      company_holidays_enabled: !!plan.company_holidays_enabled,
      carry_over_enabled: !!plan.carry_over_enabled,
      holiday_calendars: holidayCalendars,
    },
    users,
    pendingInvites,
    incomingInvites,
    isOwner: plan.owner_id === authReq.user.id,
    isFused: users.length > 1,
  });
});

router.put('/plan', async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const planId = getActivePlanId(authReq.user.id);
  const { block_weekends, holidays_enabled, holidays_region, company_holidays_enabled, carry_over_enabled } = req.body;

  const updates: string[] = [];
  const params: (string | number)[] = [];
  if (block_weekends !== undefined) { updates.push('block_weekends = ?'); params.push(block_weekends ? 1 : 0); }
  if (holidays_enabled !== undefined) { updates.push('holidays_enabled = ?'); params.push(holidays_enabled ? 1 : 0); }
  if (holidays_region !== undefined) { updates.push('holidays_region = ?'); params.push(holidays_region); }
  if (company_holidays_enabled !== undefined) { updates.push('company_holidays_enabled = ?'); params.push(company_holidays_enabled ? 1 : 0); }
  if (carry_over_enabled !== undefined) { updates.push('carry_over_enabled = ?'); params.push(carry_over_enabled ? 1 : 0); }

  if (updates.length > 0) {
    params.push(planId);
    db.prepare(`UPDATE vacay_plans SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  if (company_holidays_enabled === true) {
    const companyDates = db.prepare('SELECT date FROM vacay_company_holidays WHERE plan_id = ?').all(planId) as { date: string }[];
    for (const { date } of companyDates) {
      db.prepare('DELETE FROM vacay_entries WHERE plan_id = ? AND date = ?').run(planId, date);
    }
  }

  const updatedPlan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan;
  await migrateHolidayCalendars(planId, updatedPlan);
  await applyHolidayCalendars(planId);

  if (carry_over_enabled === false) {
    db.prepare('UPDATE vacay_user_years SET carried_over = 0 WHERE plan_id = ?').run(planId);
  }

  if (carry_over_enabled === true) {
    const years = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? ORDER BY year').all(planId) as { year: number }[];
    const users = getPlanUsers(planId);
    for (let i = 0; i < years.length - 1; i++) {
      const yr = years[i].year;
      const nextYr = years[i + 1].year;
      for (const u of users) {
        const used = (db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(u.id, planId, `${yr}-%`) as { count: number }).count;
        const config = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(u.id, planId, yr) as VacayUserYear | undefined;
        const total = (config ? config.vacation_days : 30) + (config ? config.carried_over : 0);
        const carry = Math.max(0, total - used);
        db.prepare(`
          INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, ?)
          ON CONFLICT(user_id, plan_id, year) DO UPDATE SET carried_over = ?
        `).run(u.id, planId, nextYr, carry, carry);
      }
    }
  }

  notifyPlanUsers(planId, req.headers['x-socket-id'] as string, 'vacay:settings');

  const updated = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan;
  const updatedCalendars = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ? ORDER BY sort_order, id').all(planId) as VacayHolidayCalendar[];
  res.json({
    plan: { ...updated, block_weekends: !!updated.block_weekends, holidays_enabled: !!updated.holidays_enabled, company_holidays_enabled: !!updated.company_holidays_enabled, carry_over_enabled: !!updated.carry_over_enabled, holiday_calendars: updatedCalendars }
  });
});

router.post('/plan/holiday-calendars', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { region, label, color, sort_order } = req.body;
  if (!region) return res.status(400).json({ error: 'region required' });
  const planId = getActivePlanId(authReq.user.id);
  const result = db.prepare(
    'INSERT INTO vacay_holiday_calendars (plan_id, region, label, color, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(planId, region, label || null, color || '#fecaca', sort_order ?? 0);
  const cal = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ?').get(result.lastInsertRowid) as VacayHolidayCalendar;
  notifyPlanUsers(planId, req.headers['x-socket-id'] as string, 'vacay:settings');
  res.json({ calendar: cal });
});

router.put('/plan/holiday-calendars/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const id = parseInt(req.params.id);
  const planId = getActivePlanId(authReq.user.id);
  const cal = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ? AND plan_id = ?').get(id, planId) as VacayHolidayCalendar | undefined;
  if (!cal) return res.status(404).json({ error: 'Calendar not found' });
  const { region, label, color, sort_order } = req.body;
  const updates: string[] = [];
  const params: (string | number | null)[] = [];
  if (region !== undefined) { updates.push('region = ?'); params.push(region); }
  if (label !== undefined) { updates.push('label = ?'); params.push(label); }
  if (color !== undefined) { updates.push('color = ?'); params.push(color); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order); }
  if (updates.length > 0) {
    params.push(id);
    db.prepare(`UPDATE vacay_holiday_calendars SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  const updated = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ?').get(id) as VacayHolidayCalendar;
  notifyPlanUsers(planId, req.headers['x-socket-id'] as string, 'vacay:settings');
  res.json({ calendar: updated });
});

router.delete('/plan/holiday-calendars/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const id = parseInt(req.params.id);
  const planId = getActivePlanId(authReq.user.id);
  const cal = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ? AND plan_id = ?').get(id, planId);
  if (!cal) return res.status(404).json({ error: 'Calendar not found' });
  db.prepare('DELETE FROM vacay_holiday_calendars WHERE id = ?').run(id);
  notifyPlanUsers(planId, req.headers['x-socket-id'] as string, 'vacay:settings');
  res.json({ success: true });
});

router.put('/color', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { color, target_user_id } = req.body;
  const planId = getActivePlanId(authReq.user.id);
  const userId = target_user_id ? parseInt(target_user_id) : authReq.user.id;
  const planUsers = getPlanUsers(planId);
  if (!planUsers.find(u => u.id === userId)) {
    return res.status(403).json({ error: 'User not in plan' });
  }
  db.prepare(`
    INSERT INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)
    ON CONFLICT(user_id, plan_id) DO UPDATE SET color = excluded.color
  `).run(userId, planId, color || '#6366f1');
  notifyPlanUsers(planId, req.headers['x-socket-id'] as string, 'vacay:update');
  res.json({ success: true });
});

router.post('/invite', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (user_id === authReq.user.id) return res.status(400).json({ error: 'Cannot invite yourself' });

  const targetUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(user_id);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  const plan = getActivePlan(authReq.user.id);

  const existing = db.prepare('SELECT id, status FROM vacay_plan_members WHERE plan_id = ? AND user_id = ?').get(plan.id, user_id) as { id: number; status: string } | undefined;
  if (existing) {
    if (existing.status === 'accepted') return res.status(400).json({ error: 'Already fused' });
    if (existing.status === 'pending') return res.status(400).json({ error: 'Invite already pending' });
  }

  const targetFusion = db.prepare("SELECT id FROM vacay_plan_members WHERE user_id = ? AND status = 'accepted'").get(user_id);
  if (targetFusion) return res.status(400).json({ error: 'User is already fused with another plan' });

  db.prepare('INSERT INTO vacay_plan_members (plan_id, user_id, status) VALUES (?, ?, ?)').run(plan.id, user_id, 'pending');

  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(user_id, {
      type: 'vacay:invite',
      from: { id: authReq.user.id, username: authReq.user.username },
      planId: plan.id,
    });
  } catch { /* websocket not available */ }

  res.json({ success: true });
});

router.post('/invite/accept', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { plan_id } = req.body;
  const invite = db.prepare("SELECT * FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'").get(plan_id, authReq.user.id) as VacayPlanMember | undefined;
  if (!invite) return res.status(404).json({ error: 'No pending invite' });

  db.prepare("UPDATE vacay_plan_members SET status = 'accepted' WHERE id = ?").run(invite.id);

  const ownPlan = db.prepare('SELECT id FROM vacay_plans WHERE owner_id = ?').get(authReq.user.id) as { id: number } | undefined;
  if (ownPlan && ownPlan.id !== plan_id) {
    db.prepare('UPDATE vacay_entries SET plan_id = ? WHERE plan_id = ? AND user_id = ?').run(plan_id, ownPlan.id, authReq.user.id);
    const ownYears = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ?').all(authReq.user.id, ownPlan.id) as VacayUserYear[];
    for (const y of ownYears) {
      db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, ?, ?)').run(authReq.user.id, plan_id, y.year, y.vacation_days, y.carried_over);
    }
    const colorRow = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(authReq.user.id, ownPlan.id) as { color: string } | undefined;
    if (colorRow) {
      db.prepare('INSERT OR IGNORE INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)').run(authReq.user.id, plan_id, colorRow.color);
    }
  }

  const COLORS = ['#6366f1','#ec4899','#14b8a6','#8b5cf6','#ef4444','#3b82f6','#22c55e','#06b6d4','#f43f5e','#a855f7','#10b981','#0ea5e9','#64748b','#be185d','#0d9488'];
  const existingColors = (db.prepare('SELECT color FROM vacay_user_colors WHERE plan_id = ? AND user_id != ?').all(plan_id, authReq.user.id) as { color: string }[]).map(r => r.color);
  const myColor = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(authReq.user.id, plan_id) as { color: string } | undefined;
  const effectiveColor = myColor?.color || '#6366f1';
  if (existingColors.includes(effectiveColor)) {
    const available = COLORS.find(c => !existingColors.includes(c));
    if (available) {
      db.prepare(`INSERT INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)
        ON CONFLICT(user_id, plan_id) DO UPDATE SET color = excluded.color`).run(authReq.user.id, plan_id, available);
    }
  } else if (!myColor) {
    db.prepare('INSERT OR IGNORE INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)').run(authReq.user.id, plan_id, effectiveColor);
  }

  const targetYears = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ?').all(plan_id) as { year: number }[];
  for (const y of targetYears) {
    db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, 0)').run(authReq.user.id, plan_id, y.year);
  }

  notifyPlanUsers(plan_id, req.headers['x-socket-id'] as string, 'vacay:accepted');

  res.json({ success: true });
});

router.post('/invite/decline', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { plan_id } = req.body;
  db.prepare("DELETE FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'").run(plan_id, authReq.user.id);
  notifyPlanUsers(plan_id, req.headers['x-socket-id'] as string, 'vacay:declined');
  res.json({ success: true });
});

router.post('/invite/cancel', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { user_id } = req.body;
  const plan = getActivePlan(authReq.user.id);
  db.prepare("DELETE FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'").run(plan.id, user_id);

  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(user_id, { type: 'vacay:cancelled' });
  } catch { /* */ }

  res.json({ success: true });
});

router.post('/dissolve', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const plan = getActivePlan(authReq.user.id);
  const isOwnerFlag = plan.owner_id === authReq.user.id;

  const allUserIds = getPlanUsers(plan.id).map(u => u.id);
  const companyHolidays = db.prepare('SELECT date, note FROM vacay_company_holidays WHERE plan_id = ?').all(plan.id) as { date: string; note: string }[];

  if (isOwnerFlag) {
    const members = db.prepare("SELECT user_id FROM vacay_plan_members WHERE plan_id = ? AND status = 'accepted'").all(plan.id) as { user_id: number }[];
    for (const m of members) {
      const memberPlan = getOwnPlan(m.user_id);
      db.prepare('UPDATE vacay_entries SET plan_id = ? WHERE plan_id = ? AND user_id = ?').run(memberPlan.id, plan.id, m.user_id);
      for (const ch of companyHolidays) {
        db.prepare('INSERT OR IGNORE INTO vacay_company_holidays (plan_id, date, note) VALUES (?, ?, ?)').run(memberPlan.id, ch.date, ch.note);
      }
    }
    db.prepare('DELETE FROM vacay_plan_members WHERE plan_id = ?').run(plan.id);
  } else {
    const ownPlan = getOwnPlan(authReq.user.id);
    db.prepare('UPDATE vacay_entries SET plan_id = ? WHERE plan_id = ? AND user_id = ?').run(ownPlan.id, plan.id, authReq.user.id);
    for (const ch of companyHolidays) {
      db.prepare('INSERT OR IGNORE INTO vacay_company_holidays (plan_id, date, note) VALUES (?, ?, ?)').run(ownPlan.id, ch.date, ch.note);
    }
    db.prepare("DELETE FROM vacay_plan_members WHERE plan_id = ? AND user_id = ?").run(plan.id, authReq.user.id);
  }

  try {
    const { broadcastToUser } = require('../websocket');
    allUserIds.filter(id => id !== authReq.user.id).forEach(id => broadcastToUser(id, { type: 'vacay:dissolved' }));
  } catch { /* */ }

  res.json({ success: true });
});

router.get('/available-users', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const planId = getActivePlanId(authReq.user.id);
  const users = db.prepare(`
    SELECT u.id, u.username, u.email FROM users u
    WHERE u.id != ?
    AND u.id NOT IN (SELECT user_id FROM vacay_plan_members WHERE plan_id = ?)
    AND u.id NOT IN (SELECT user_id FROM vacay_plan_members WHERE status = 'accepted')
    AND u.id NOT IN (SELECT owner_id FROM vacay_plans WHERE id IN (
      SELECT plan_id FROM vacay_plan_members WHERE status = 'accepted'
    ))
    ORDER BY u.username
  `).all(authReq.user.id, planId);
  res.json({ users });
});

router.get('/years', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const planId = getActivePlanId(authReq.user.id);
  const years = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? ORDER BY year').all(planId) as { year: number }[];
  res.json({ years: years.map(y => y.year) });
});

router.post('/years', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { year } = req.body;
  if (!year) return res.status(400).json({ error: 'Year required' });
  const planId = getActivePlanId(authReq.user.id);
  try {
    db.prepare('INSERT INTO vacay_years (plan_id, year) VALUES (?, ?)').run(planId, year);
    const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
    const carryOverEnabled = plan ? !!plan.carry_over_enabled : true;
    const users = getPlanUsers(planId);
    for (const u of users) {
      let carriedOver = 0;
      if (carryOverEnabled) {
        const prevConfig = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(u.id, planId, year - 1) as VacayUserYear | undefined;
        if (prevConfig) {
          const used = (db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(u.id, planId, `${year - 1}-%`) as { count: number }).count;
          const total = prevConfig.vacation_days + prevConfig.carried_over;
          carriedOver = Math.max(0, total - used);
        }
      }
      db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, ?)').run(u.id, planId, year, carriedOver);
    }
  } catch { /* exists */ }
  notifyPlanUsers(planId, req.headers['x-socket-id'] as string, 'vacay:settings');
  const years = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? ORDER BY year').all(planId) as { year: number }[];
  res.json({ years: years.map(y => y.year) });
});

router.delete('/years/:year', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const year = parseInt(req.params.year);
  const planId = getActivePlanId(authReq.user.id);
  db.prepare('DELETE FROM vacay_years WHERE plan_id = ? AND year = ?').run(planId, year);
  db.prepare("DELETE FROM vacay_entries WHERE plan_id = ? AND date LIKE ?").run(planId, `${year}-%`);
  db.prepare("DELETE FROM vacay_company_holidays WHERE plan_id = ? AND date LIKE ?").run(planId, `${year}-%`);
  notifyPlanUsers(planId, req.headers['x-socket-id'] as string, 'vacay:settings');
  const years = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? ORDER BY year').all(planId) as { year: number }[];
  res.json({ years: years.map(y => y.year) });
});

router.get('/entries/:year', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const year = req.params.year;
  const planId = getActivePlanId(authReq.user.id);
  const entries = db.prepare(`
    SELECT e.*, u.username as person_name, COALESCE(c.color, '#6366f1') as person_color
    FROM vacay_entries e
    JOIN users u ON e.user_id = u.id
    LEFT JOIN vacay_user_colors c ON c.user_id = e.user_id AND c.plan_id = e.plan_id
    WHERE e.plan_id = ? AND e.date LIKE ?
  `).all(planId, `${year}-%`);
  const companyHolidays = db.prepare("SELECT * FROM vacay_company_holidays WHERE plan_id = ? AND date LIKE ?").all(planId, `${year}-%`);
  res.json({ entries, companyHolidays });
});

router.post('/entries/toggle', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { date, target_user_id } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  const planId = getActivePlanId(authReq.user.id);
  let userId = authReq.user.id;
  if (target_user_id && parseInt(target_user_id) !== authReq.user.id) {
    const planUsers = getPlanUsers(planId);
    const tid = parseInt(target_user_id);
    if (!planUsers.find(u => u.id === tid)) {
      return res.status(403).json({ error: 'User not in plan' });
    }
    userId = tid;
  }
  const existing = db.prepare('SELECT id FROM vacay_entries WHERE user_id = ? AND date = ? AND plan_id = ?').get(userId, date, planId) as { id: number } | undefined;
  if (existing) {
    db.prepare('DELETE FROM vacay_entries WHERE id = ?').run(existing.id);
    notifyPlanUsers(planId, req.headers['x-socket-id'] as string);
    res.json({ action: 'removed' });
  } else {
    db.prepare('INSERT INTO vacay_entries (plan_id, user_id, date, note) VALUES (?, ?, ?, ?)').run(planId, userId, date, '');
    notifyPlanUsers(planId, req.headers['x-socket-id'] as string);
    res.json({ action: 'added' });
  }
});

router.post('/entries/company-holiday', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { date, note } = req.body;
  const planId = getActivePlanId(authReq.user.id);
  const existing = db.prepare('SELECT id FROM vacay_company_holidays WHERE plan_id = ? AND date = ?').get(planId, date) as { id: number } | undefined;
  if (existing) {
    db.prepare('DELETE FROM vacay_company_holidays WHERE id = ?').run(existing.id);
    notifyPlanUsers(planId, req.headers['x-socket-id'] as string);
    res.json({ action: 'removed' });
  } else {
    db.prepare('INSERT INTO vacay_company_holidays (plan_id, date, note) VALUES (?, ?, ?)').run(planId, date, note || '');
    db.prepare('DELETE FROM vacay_entries WHERE plan_id = ? AND date = ?').run(planId, date);
    notifyPlanUsers(planId, req.headers['x-socket-id'] as string);
    res.json({ action: 'added' });
  }
});

router.get('/stats/:year', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const year = parseInt(req.params.year);
  const planId = getActivePlanId(authReq.user.id);
  const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
  const carryOverEnabled = plan ? !!plan.carry_over_enabled : true;
  const users = getPlanUsers(planId);

  const stats = users.map(u => {
    const used = (db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(u.id, planId, `${year}-%`) as { count: number }).count;
    const config = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(u.id, planId, year) as VacayUserYear | undefined;
    const vacationDays = config ? config.vacation_days : 30;
    const carriedOver = carryOverEnabled ? (config ? config.carried_over : 0) : 0;
    const total = vacationDays + carriedOver;
    const remaining = total - used;
    const colorRow = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(u.id, planId) as { color: string } | undefined;

    const nextYearExists = db.prepare('SELECT id FROM vacay_years WHERE plan_id = ? AND year = ?').get(planId, year + 1);
    if (nextYearExists && carryOverEnabled) {
      const carry = Math.max(0, remaining);
      db.prepare(`
        INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, ?)
        ON CONFLICT(user_id, plan_id, year) DO UPDATE SET carried_over = ?
      `).run(u.id, planId, year + 1, carry, carry);
    }

    return {
      user_id: u.id, person_name: u.username, person_color: colorRow?.color || '#6366f1',
      year, vacation_days: vacationDays, carried_over: carriedOver,
      total_available: total, used, remaining,
    };
  });

  res.json({ stats });
});

router.put('/stats/:year', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const year = parseInt(req.params.year);
  const { vacation_days, target_user_id } = req.body;
  const planId = getActivePlanId(authReq.user.id);
  const userId = target_user_id ? parseInt(target_user_id) : authReq.user.id;
  const planUsers = getPlanUsers(planId);
  if (!planUsers.find(u => u.id === userId)) {
    return res.status(403).json({ error: 'User not in plan' });
  }
  db.prepare(`
    INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(user_id, plan_id, year) DO UPDATE SET vacation_days = excluded.vacation_days
  `).run(userId, planId, year, vacation_days);
  notifyPlanUsers(planId, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

router.get('/holidays/countries', async (_req: Request, res: Response) => {
  const cacheKey = 'countries';
  const cached = holidayCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return res.json(cached.data);
  try {
    const resp = await fetch('https://date.nager.at/api/v3/AvailableCountries');
    const data = await resp.json();
    holidayCache.set(cacheKey, { data, time: Date.now() });
    res.json(data);
  } catch {
    res.status(502).json({ error: 'Failed to fetch countries' });
  }
});

router.get('/holidays/:year/:country', async (req: Request, res: Response) => {
  const { year, country } = req.params;
  const cacheKey = `${year}-${country}`;
  const cached = holidayCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return res.json(cached.data);
  try {
    const resp = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
    const data = await resp.json();
    holidayCache.set(cacheKey, { data, time: Date.now() });
    res.json(data);
  } catch {
    res.status(502).json({ error: 'Failed to fetch holidays' });
  }
});

export default router;
