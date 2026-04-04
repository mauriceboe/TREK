import { db } from '../db/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VacayPlan {
  id: number;
  owner_id: number;
  block_weekends: number;
  holidays_enabled: number;
  holidays_region: string | null;
  company_holidays_enabled: number;
  carry_over_enabled: number;
}

export interface VacayUserYear {
  user_id: number;
  plan_id: number;
  year: number;
  vacation_days: number;
  carried_over: number;
}

export interface VacayUser {
  id: number;
  username: string;
  email: string;
}

export interface VacayPlanMember {
  id: number;
  plan_id: number;
  user_id: number;
  status: string;
  created_at?: string;
}

export interface Holiday {
  date: string;
  localName?: string;
  name?: string;
  global?: boolean;
  counties?: string[] | null;
}

export interface VacayHolidayCalendar {
  id: number;
  plan_id: number;
  region: string;
  label: string | null;
  color: string;
  sort_order: number;
}

// ---------------------------------------------------------------------------
// Holiday cache (shared in-process)
// ---------------------------------------------------------------------------

const holidayCache = new Map<string, { data: unknown; time: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Color palette for auto-assign
// ---------------------------------------------------------------------------

const COLORS = [
  '#6366f1', '#ec4899', '#14b8a6', '#8b5cf6', '#ef4444',
  '#3b82f6', '#22c55e', '#06b6d4', '#f43f5e', '#a855f7',
  '#10b981', '#0ea5e9', '#64748b', '#be185d', '#0d9488',
];

// ---------------------------------------------------------------------------
// Plan management
// ---------------------------------------------------------------------------

export function getOwnPlan(userId: number): VacayPlan {
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

export function getActivePlan(userId: number): VacayPlan {
  const membership = db.prepare(`
    SELECT plan_id FROM vacay_plan_members WHERE user_id = ? AND status = 'accepted'
  `).get(userId) as { plan_id: number } | undefined;
  if (membership) {
    return db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(membership.plan_id) as VacayPlan;
  }
  return getOwnPlan(userId);
}

export function getActivePlanId(userId: number): number {
  return getActivePlan(userId).id;
}

export function getPlanUsers(planId: number): VacayUser[] {
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

// ---------------------------------------------------------------------------
// WebSocket notifications
// ---------------------------------------------------------------------------

export function notifyPlanUsers(planId: number, excludeSid: string | undefined, event = 'vacay:update'): void {
  try {
    const { broadcastToUser } = require('../websocket');
    const plan = db.prepare('SELECT owner_id FROM vacay_plans WHERE id = ?').get(planId) as { owner_id: number } | undefined;
    if (!plan) return;
    const userIds = [plan.owner_id];
    const members = db.prepare("SELECT user_id FROM vacay_plan_members WHERE plan_id = ? AND status = 'accepted'").all(planId) as { user_id: number }[];
    members.forEach(m => userIds.push(m.user_id));
    userIds.forEach(id => broadcastToUser(id, { type: event }, excludeSid));
  } catch { /* websocket not available */ }
}

// ---------------------------------------------------------------------------
// Holiday calendar helpers
// ---------------------------------------------------------------------------

export async function applyHolidayCalendars(planId: number): Promise<void> {
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
          }
        }
      } catch { /* API error, skip */ }
    }
  }
}

export async function migrateHolidayCalendars(planId: number, plan: VacayPlan): Promise<void> {
  const existing = db.prepare('SELECT id FROM vacay_holiday_calendars WHERE plan_id = ?').get(planId);
  if (existing) return;
  if (plan.holidays_enabled && plan.holidays_region) {
    db.prepare(
      'INSERT INTO vacay_holiday_calendars (plan_id, region, label, color, sort_order) VALUES (?, ?, NULL, ?, 0)'
    ).run(planId, plan.holidays_region, '#fecaca');
  }
}

// ---------------------------------------------------------------------------
// Plan settings
// ---------------------------------------------------------------------------

export interface UpdatePlanBody {
  block_weekends?: boolean;
  holidays_enabled?: boolean;
  holidays_region?: string;
  company_holidays_enabled?: boolean;
  carry_over_enabled?: boolean;
  weekend_days?: string;
}

export async function updatePlan(planId: number, body: UpdatePlanBody, socketId: string | undefined) {
  const { block_weekends, holidays_enabled, holidays_region, company_holidays_enabled, carry_over_enabled, weekend_days } = body;

  const updates: string[] = [];
  const params: (string | number)[] = [];
  if (block_weekends !== undefined) { updates.push('block_weekends = ?'); params.push(block_weekends ? 1 : 0); }
  if (holidays_enabled !== undefined) { updates.push('holidays_enabled = ?'); params.push(holidays_enabled ? 1 : 0); }
  if (holidays_region !== undefined) { updates.push('holidays_region = ?'); params.push(holidays_region); }
  if (company_holidays_enabled !== undefined) { updates.push('company_holidays_enabled = ?'); params.push(company_holidays_enabled ? 1 : 0); }
  if (carry_over_enabled !== undefined) { updates.push('carry_over_enabled = ?'); params.push(carry_over_enabled ? 1 : 0); }
  if (weekend_days !== undefined) { updates.push('weekend_days = ?'); params.push(String(weekend_days)); }

  if (updates.length > 0) {
    params.push(planId);
    db.prepare(`UPDATE vacay_plans SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  if (company_holidays_enabled === true) {
    const companyDates = db.prepare('SELECT user_id, date FROM vacay_company_holidays WHERE plan_id = ?').all(planId) as { user_id: number; date: string }[];
    for (const { user_id, date } of companyDates) {
      db.prepare('DELETE FROM vacay_entries WHERE plan_id = ? AND user_id = ? AND date = ?').run(planId, user_id, date);
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

  notifyPlanUsers(planId, socketId, 'vacay:settings');

  const updated = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan;
  const updatedCalendars = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ? ORDER BY sort_order, id').all(planId) as VacayHolidayCalendar[];
  return {
    plan: {
      ...updated,
      block_weekends: !!updated.block_weekends,
      holidays_enabled: !!updated.holidays_enabled,
      company_holidays_enabled: !!updated.company_holidays_enabled,
      carry_over_enabled: !!updated.carry_over_enabled,
      holiday_calendars: updatedCalendars,
    },
  };
}

// ---------------------------------------------------------------------------
// Holiday calendars CRUD
// ---------------------------------------------------------------------------

export function addHolidayCalendar(planId: number, region: string, label: string | null, color: string | undefined, sortOrder: number | undefined, socketId: string | undefined) {
  const result = db.prepare(
    'INSERT INTO vacay_holiday_calendars (plan_id, region, label, color, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(planId, region, label || null, color || '#fecaca', sortOrder ?? 0);
  const cal = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ?').get(result.lastInsertRowid) as VacayHolidayCalendar;
  notifyPlanUsers(planId, socketId, 'vacay:settings');
  return cal;
}

export function updateHolidayCalendar(
  calId: number,
  planId: number,
  body: { region?: string; label?: string | null; color?: string; sort_order?: number },
  socketId: string | undefined,
): VacayHolidayCalendar | null {
  const cal = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ? AND plan_id = ?').get(calId, planId) as VacayHolidayCalendar | undefined;
  if (!cal) return null;
  const { region, label, color, sort_order } = body;
  const updates: string[] = [];
  const params: (string | number | null)[] = [];
  if (region !== undefined) { updates.push('region = ?'); params.push(region); }
  if (label !== undefined) { updates.push('label = ?'); params.push(label); }
  if (color !== undefined) { updates.push('color = ?'); params.push(color); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order); }
  if (updates.length > 0) {
    params.push(calId);
    db.prepare(`UPDATE vacay_holiday_calendars SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  const updated = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ?').get(calId) as VacayHolidayCalendar;
  notifyPlanUsers(planId, socketId, 'vacay:settings');
  return updated;
}

export function deleteHolidayCalendar(calId: number, planId: number, socketId: string | undefined): boolean {
  const cal = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ? AND plan_id = ?').get(calId, planId);
  if (!cal) return false;
  db.prepare('DELETE FROM vacay_holiday_calendars WHERE id = ?').run(calId);
  notifyPlanUsers(planId, socketId, 'vacay:settings');
  return true;
}

// ---------------------------------------------------------------------------
// User colors
// ---------------------------------------------------------------------------

export function setUserColor(userId: number, planId: number, color: string | undefined, socketId: string | undefined): void {
  db.prepare(`
    INSERT INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)
    ON CONFLICT(user_id, plan_id) DO UPDATE SET color = excluded.color
  `).run(userId, planId, color || '#6366f1');
  notifyPlanUsers(planId, socketId, 'vacay:update');
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export function sendInvite(planId: number, inviterId: number, inviterUsername: string, inviterEmail: string, targetUserId: number): { error?: string; status?: number } {
  if (targetUserId === inviterId) return { error: 'Cannot invite yourself', status: 400 };

  const targetUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetUserId);
  if (!targetUser) return { error: 'User not found', status: 404 };

  const existing = db.prepare('SELECT id, status FROM vacay_plan_members WHERE plan_id = ? AND user_id = ?').get(planId, targetUserId) as { id: number; status: string } | undefined;
  if (existing) {
    if (existing.status === 'accepted') return { error: 'Already fused', status: 400 };
    if (existing.status === 'pending') return { error: 'Invite already pending', status: 400 };
  }

  const targetFusion = db.prepare("SELECT id FROM vacay_plan_members WHERE user_id = ? AND status = 'accepted'").get(targetUserId);
  if (targetFusion) return { error: 'User is already fused with another plan', status: 400 };

  db.prepare('INSERT INTO vacay_plan_members (plan_id, user_id, status) VALUES (?, ?, ?)').run(planId, targetUserId, 'pending');

  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(targetUserId, {
      type: 'vacay:invite',
      from: { id: inviterId, username: inviterUsername },
      planId,
    });
  } catch { /* websocket not available */ }

  // Notify invited user
  import('../services/notifications').then(({ notify }) => {
    notify({ userId: targetUserId, event: 'vacay_invite', params: { actor: inviterEmail } }).catch(() => {});
  });

  return {};
}

export function acceptInvite(userId: number, planId: number, socketId: string | undefined): { error?: string; status?: number } {
  const invite = db.prepare("SELECT * FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'").get(planId, userId) as VacayPlanMember | undefined;
  if (!invite) return { error: 'No pending invite', status: 404 };

  db.prepare("UPDATE vacay_plan_members SET status = 'accepted' WHERE id = ?").run(invite.id);

  // Migrate data from user's own plan
  const ownPlan = db.prepare('SELECT id FROM vacay_plans WHERE owner_id = ?').get(userId) as { id: number } | undefined;
  if (ownPlan && ownPlan.id !== planId) {
    db.prepare('UPDATE vacay_entries SET plan_id = ? WHERE plan_id = ? AND user_id = ?').run(planId, ownPlan.id, userId);
    db.prepare('UPDATE vacay_company_holidays SET plan_id = ? WHERE plan_id = ? AND user_id = ?').run(planId, ownPlan.id, userId);
    const ownYears = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ?').all(userId, ownPlan.id) as VacayUserYear[];
    for (const y of ownYears) {
      db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, ?, ?)').run(userId, planId, y.year, y.vacation_days, y.carried_over);
    }
    const colorRow = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(userId, ownPlan.id) as { color: string } | undefined;
    if (colorRow) {
      db.prepare('INSERT OR IGNORE INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)').run(userId, planId, colorRow.color);
    }
  }

  // Auto-assign unique color
  const existingColors = (db.prepare('SELECT color FROM vacay_user_colors WHERE plan_id = ? AND user_id != ?').all(planId, userId) as { color: string }[]).map(r => r.color);
  const myColor = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(userId, planId) as { color: string } | undefined;
  const effectiveColor = myColor?.color || '#6366f1';
  if (existingColors.includes(effectiveColor)) {
    const available = COLORS.find(c => !existingColors.includes(c));
    if (available) {
      db.prepare(`INSERT INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)
        ON CONFLICT(user_id, plan_id) DO UPDATE SET color = excluded.color`).run(userId, planId, available);
    }
  } else if (!myColor) {
    db.prepare('INSERT OR IGNORE INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)').run(userId, planId, effectiveColor);
  }

  // Ensure user has rows for all plan years
  const targetYears = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ?').all(planId) as { year: number }[];
  for (const y of targetYears) {
    db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, 0)').run(userId, planId, y.year);
  }

  notifyPlanUsers(planId, socketId, 'vacay:accepted');
  return {};
}

export function declineInvite(userId: number, planId: number, socketId: string | undefined): void {
  db.prepare("DELETE FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'").run(planId, userId);
  notifyPlanUsers(planId, socketId, 'vacay:declined');
}

export function cancelInvite(planId: number, targetUserId: number): void {
  db.prepare("DELETE FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'").run(planId, targetUserId);

  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(targetUserId, { type: 'vacay:cancelled' });
  } catch { /* */ }
}

// ---------------------------------------------------------------------------
// Plan dissolution
// ---------------------------------------------------------------------------

export function dissolvePlan(userId: number, socketId: string | undefined): void {
  const plan = getActivePlan(userId);
  const isOwnerFlag = plan.owner_id === userId;

  const allUserIds = getPlanUsers(plan.id).map(u => u.id);
  const companyHolidays = db.prepare('SELECT user_id, date, note FROM vacay_company_holidays WHERE plan_id = ?').all(plan.id) as { user_id: number; date: string; note: string }[];

  if (isOwnerFlag) {
    const members = db.prepare("SELECT user_id FROM vacay_plan_members WHERE plan_id = ? AND status = 'accepted'").all(plan.id) as { user_id: number }[];
    for (const m of members) {
      const memberPlan = getOwnPlan(m.user_id);
      db.prepare('UPDATE vacay_entries SET plan_id = ? WHERE plan_id = ? AND user_id = ?').run(memberPlan.id, plan.id, m.user_id);
      for (const ch of companyHolidays.filter(ch => ch.user_id === m.user_id)) {
        db.prepare('INSERT OR IGNORE INTO vacay_company_holidays (plan_id, user_id, date, note) VALUES (?, ?, ?, ?)').run(memberPlan.id, m.user_id, ch.date, ch.note);
      }
    }
    db.prepare('DELETE FROM vacay_plan_members WHERE plan_id = ?').run(plan.id);
  } else {
    const ownPlan = getOwnPlan(userId);
    db.prepare('UPDATE vacay_entries SET plan_id = ? WHERE plan_id = ? AND user_id = ?').run(ownPlan.id, plan.id, userId);
    for (const ch of companyHolidays.filter(ch => ch.user_id === userId)) {
      db.prepare('INSERT OR IGNORE INTO vacay_company_holidays (plan_id, user_id, date, note) VALUES (?, ?, ?, ?)').run(ownPlan.id, userId, ch.date, ch.note);
    }
    db.prepare("DELETE FROM vacay_plan_members WHERE plan_id = ? AND user_id = ?").run(plan.id, userId);
  }

  try {
    const { broadcastToUser } = require('../websocket');
    allUserIds.filter(id => id !== userId).forEach(id => broadcastToUser(id, { type: 'vacay:dissolved' }));
  } catch { /* */ }
}

// ---------------------------------------------------------------------------
// Available users
// ---------------------------------------------------------------------------

export function getAvailableUsers(userId: number, planId: number) {
  return db.prepare(`
    SELECT u.id, u.username, u.email FROM users u
    WHERE u.id != ?
    AND u.id NOT IN (SELECT user_id FROM vacay_plan_members WHERE plan_id = ?)
    AND u.id NOT IN (SELECT user_id FROM vacay_plan_members WHERE status = 'accepted')
    AND u.id NOT IN (SELECT owner_id FROM vacay_plans WHERE id IN (
      SELECT plan_id FROM vacay_plan_members WHERE status = 'accepted'
    ))
    ORDER BY u.username
  `).all(userId, planId);
}

// ---------------------------------------------------------------------------
// Years
// ---------------------------------------------------------------------------

export function listYears(planId: number): number[] {
  const rows = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? ORDER BY year').all(planId) as { year: number }[];
  return rows.map(y => y.year);
}

export function addYear(planId: number, year: number, socketId: string | undefined): number[] {
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
  } catch { /* year already exists */ }
  notifyPlanUsers(planId, socketId, 'vacay:settings');
  return listYears(planId);
}

export function deleteYear(planId: number, year: number, socketId: string | undefined): number[] {
  db.prepare('DELETE FROM vacay_years WHERE plan_id = ? AND year = ?').run(planId, year);
  db.prepare("DELETE FROM vacay_entries WHERE plan_id = ? AND date LIKE ?").run(planId, `${year}-%`);
  db.prepare("DELETE FROM vacay_company_holidays WHERE plan_id = ? AND date LIKE ?").run(planId, `${year}-%`);
  db.prepare('DELETE FROM vacay_user_years WHERE plan_id = ? AND year = ?').run(planId, year);

  // Recalculate carry-over for year+1 if it exists, since its previous year has changed
  const nextYearExists = db.prepare('SELECT id FROM vacay_years WHERE plan_id = ? AND year = ?').get(planId, year + 1);
  if (nextYearExists) {
    const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
    const carryOverEnabled = plan ? !!plan.carry_over_enabled : true;
    const users = getPlanUsers(planId);
    const prevYear = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? AND year < ? ORDER BY year DESC LIMIT 1').get(planId, year + 1) as { year: number } | undefined;

    for (const u of users) {
      let carry = 0;
      if (carryOverEnabled && prevYear) {
        const prevConfig = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(u.id, planId, prevYear.year) as VacayUserYear | undefined;
        if (prevConfig) {
          const used = (db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(u.id, planId, `${prevYear.year}-%`) as { count: number }).count;
          const total = prevConfig.vacation_days + prevConfig.carried_over;
          carry = Math.max(0, total - used);
        }
      }
      db.prepare('UPDATE vacay_user_years SET carried_over = ? WHERE user_id = ? AND plan_id = ? AND year = ?').run(carry, u.id, planId, year + 1);
    }
  }

  notifyPlanUsers(planId, socketId, 'vacay:settings');
  return listYears(planId);
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export function getEntries(planId: number, year: string) {
  const entries = db.prepare(`
    SELECT e.*, u.username as person_name, COALESCE(c.color, '#6366f1') as person_color
    FROM vacay_entries e
    JOIN users u ON e.user_id = u.id
    LEFT JOIN vacay_user_colors c ON c.user_id = e.user_id AND c.plan_id = e.plan_id
    WHERE e.plan_id = ? AND e.date LIKE ?
  `).all(planId, `${year}-%`);
  const companyHolidays = db.prepare(`
    SELECT ch.*, u.username as person_name, COALESCE(c.color, '#6366f1') as person_color
    FROM vacay_company_holidays ch
    JOIN users u ON ch.user_id = u.id
    LEFT JOIN vacay_user_colors c ON c.user_id = ch.user_id AND c.plan_id = ch.plan_id
    WHERE ch.plan_id = ? AND ch.date LIKE ?
  `).all(planId, `${year}-%`);
  return { entries, companyHolidays };
}

export function toggleEntry(userId: number, planId: number, date: string, socketId: string | undefined): { action: string } {
  const existing = db.prepare('SELECT id FROM vacay_entries WHERE user_id = ? AND date = ? AND plan_id = ?').get(userId, date, planId) as { id: number } | undefined;
  if (existing) {
    db.prepare('DELETE FROM vacay_entries WHERE id = ?').run(existing.id);
    notifyPlanUsers(planId, socketId);
    return { action: 'removed' };
  } else {
    db.prepare('INSERT INTO vacay_entries (plan_id, user_id, date, note) VALUES (?, ?, ?, ?)').run(planId, userId, date, '');
    notifyPlanUsers(planId, socketId);
    return { action: 'added' };
  }
}

export function toggleCompanyHoliday(userId: number, planId: number, date: string, note: string | undefined, socketId: string | undefined): { action: string } {
  const existing = db.prepare('SELECT id FROM vacay_company_holidays WHERE plan_id = ? AND user_id = ? AND date = ?').get(planId, userId, date) as { id: number } | undefined;
  if (existing) {
    db.prepare('DELETE FROM vacay_company_holidays WHERE id = ?').run(existing.id);
    notifyPlanUsers(planId, socketId);
    return { action: 'removed' };
  } else {
    db.prepare('INSERT INTO vacay_company_holidays (plan_id, user_id, date, note) VALUES (?, ?, ?, ?)').run(planId, userId, date, note || '');
    db.prepare('DELETE FROM vacay_entries WHERE plan_id = ? AND user_id = ? AND date = ?').run(planId, userId, date);
    notifyPlanUsers(planId, socketId);
    return { action: 'added' };
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function getStats(planId: number, year: number) {
  const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
  const carryOverEnabled = plan ? !!plan.carry_over_enabled : true;
  const users = getPlanUsers(planId);

  return users.map(u => {
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
}

export function updateStats(userId: number, planId: number, year: number, vacationDays: number, socketId: string | undefined): void {
  db.prepare(`
    INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(user_id, plan_id, year) DO UPDATE SET vacation_days = excluded.vacation_days
  `).run(userId, planId, year, vacationDays);
  notifyPlanUsers(planId, socketId);
}

// ---------------------------------------------------------------------------
// GET /plan composite
// ---------------------------------------------------------------------------

export function getPlanData(userId: number) {
  const plan = getActivePlan(userId);
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
  `).all(userId);

  const holidayCalendars = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ? ORDER BY sort_order, id').all(activePlanId) as VacayHolidayCalendar[];

  return {
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
    isOwner: plan.owner_id === userId,
    isFused: users.length > 1,
  };
}

// ---------------------------------------------------------------------------
// Holidays (nager.at proxy with cache)
// ---------------------------------------------------------------------------

export async function getCountries(): Promise<{ data?: unknown; error?: string }> {
  const cacheKey = 'countries';
  const cached = holidayCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return { data: cached.data };
  try {
    const resp = await fetch('https://date.nager.at/api/v3/AvailableCountries');
    const data = await resp.json();
    holidayCache.set(cacheKey, { data, time: Date.now() });
    return { data };
  } catch {
    return { error: 'Failed to fetch countries' };
  }
}

export async function getHolidays(year: string, country: string): Promise<{ data?: unknown; error?: string }> {
  const cacheKey = `${year}-${country}`;
  const cached = holidayCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return { data: cached.data };
  try {
    const resp = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
    const data = await resp.json();
    holidayCache.set(cacheKey, { data, time: Date.now() });
    return { data };
  } catch {
    return { error: 'Failed to fetch holidays' };
  }
}
