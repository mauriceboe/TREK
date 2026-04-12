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

function getConnectedUserIds(userId: number): number[] {
  const rows = db.prepare(`
    SELECT viewer_id as other_id FROM vacay_read_access WHERE granter_id = ? AND status = 'accepted'
    UNION
    SELECT granter_id as other_id FROM vacay_read_access WHERE viewer_id = ? AND status = 'accepted'
  `).all(userId, userId) as { other_id: number }[];
  return rows.map(r => r.other_id);
}

// Only auto-assigns if the user still has the default color — never overwrites a user's custom choice.
// avoidUserIds: whose colors to avoid (include the other party so they always get distinct colors).
function assignUniqueColorIfDefault(userId: number, planId: number, avoidUserIds: number[]): void {
  const current = (db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(userId, planId) as { color: string } | undefined)?.color;
  if (current && current !== COLORS[0]) return;
  const usedColors = new Set<string>();
  for (const uid of avoidUserIds) {
    const p = db.prepare('SELECT id FROM vacay_plans WHERE owner_id = ?').get(uid) as { id: number } | undefined;
    if (p) {
      const c = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(uid, p.id) as { color: string } | undefined;
      if (c) usedColors.add(c.color);
    }
  }
  const pick = COLORS.find(c => !usedColors.has(c)) ?? COLORS[1];
  db.prepare(`
    INSERT INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)
    ON CONFLICT(user_id, plan_id) DO UPDATE SET color = excluded.color
  `).run(userId, planId, pick);
}

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

// ---------------------------------------------------------------------------
// WebSocket notifications
// ---------------------------------------------------------------------------

export function notifyPlanOwnerAndViewers(planId: number, excludeSid: string | undefined, event = 'vacay:update'): void {
  try {
    const { broadcastToUser } = require('../websocket');
    const plan = db.prepare('SELECT owner_id FROM vacay_plans WHERE id = ?').get(planId) as { owner_id: number } | undefined;
    if (!plan) return;
    broadcastToUser(plan.owner_id, { type: event }, excludeSid);
    // Also notify all viewers who have accepted access to this plan
    const viewers = db.prepare(`
      SELECT viewer_id FROM vacay_read_access WHERE granter_id = ? AND status = 'accepted'
    `).all(plan.owner_id) as { viewer_id: number }[];
    viewers.forEach(v => broadcastToUser(v.viewer_id, { type: event }, excludeSid));
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
            db.prepare('DELETE FROM vacay_company_holidays WHERE plan_id = ? AND date = ?').run(planId, h.date);
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
  week_start?: number;
}

export async function updatePlan(planId: number, body: UpdatePlanBody, socketId: string | undefined) {
  const { block_weekends, holidays_enabled, holidays_region, company_holidays_enabled, carry_over_enabled, weekend_days, week_start } = body;

  const updates: string[] = [];
  const params: (string | number)[] = [];
  if (block_weekends !== undefined) { updates.push('block_weekends = ?'); params.push(block_weekends ? 1 : 0); }
  if (holidays_enabled !== undefined) { updates.push('holidays_enabled = ?'); params.push(holidays_enabled ? 1 : 0); }
  if (holidays_region !== undefined) { updates.push('holidays_region = ?'); params.push(holidays_region); }
  if (company_holidays_enabled !== undefined) { updates.push('company_holidays_enabled = ?'); params.push(company_holidays_enabled ? 1 : 0); }
  if (carry_over_enabled !== undefined) { updates.push('carry_over_enabled = ?'); params.push(carry_over_enabled ? 1 : 0); }
  if (weekend_days !== undefined) { updates.push('weekend_days = ?'); params.push(String(weekend_days)); }
  if (week_start !== undefined) { updates.push('week_start = ?'); params.push(week_start === 0 ? 0 : 1); }

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
    const ownerId = (db.prepare('SELECT owner_id FROM vacay_plans WHERE id = ?').get(planId) as { owner_id: number }).owner_id;
    for (let i = 0; i < years.length - 1; i++) {
      const yr = years[i].year;
      const nextYr = years[i + 1].year;
      const used = (db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(ownerId, planId, `${yr}-%`) as { count: number }).count;
      const config = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(ownerId, planId, yr) as VacayUserYear | undefined;
      const total = (config ? config.vacation_days : 30) + (config ? config.carried_over : 0);
      const carry = Math.max(0, total - used);
      db.prepare(`
        INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, ?)
        ON CONFLICT(user_id, plan_id, year) DO UPDATE SET carried_over = ?
      `).run(ownerId, planId, nextYr, carry, carry);
    }
  }

  notifyPlanOwnerAndViewers(planId, socketId, 'vacay:settings');

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
  notifyPlanOwnerAndViewers(planId, socketId, 'vacay:settings');
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
  notifyPlanOwnerAndViewers(planId, socketId, 'vacay:settings');
  return updated;
}

export function deleteHolidayCalendar(calId: number, planId: number, socketId: string | undefined): boolean {
  const cal = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ? AND plan_id = ?').get(calId, planId);
  if (!cal) return false;
  db.prepare('DELETE FROM vacay_holiday_calendars WHERE id = ?').run(calId);
  notifyPlanOwnerAndViewers(planId, socketId, 'vacay:settings');
  return true;
}

// ---------------------------------------------------------------------------
// User color
// ---------------------------------------------------------------------------

export function setUserColor(userId: number, planId: number, color: string | undefined, socketId: string | undefined): void {
  db.prepare(`
    INSERT INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)
    ON CONFLICT(user_id, plan_id) DO UPDATE SET color = excluded.color
  `).run(userId, planId, color || '#6366f1');
  notifyPlanOwnerAndViewers(planId, socketId, 'vacay:update');
}

// ---------------------------------------------------------------------------
// Read-access invitations
// ---------------------------------------------------------------------------

export function grantAccess(
  granterId: number, granterUsername: string, granterEmail: string, viewerUserId: number,
): { error?: string; status?: number } {
  if (viewerUserId === granterId) return { error: 'Cannot share with yourself', status: 400 };

  const viewer = db.prepare('SELECT id FROM users WHERE id = ?').get(viewerUserId);
  if (!viewer) return { error: 'User not found', status: 404 };

  const existing = db.prepare('SELECT id, status FROM vacay_read_access WHERE granter_id = ? AND viewer_id = ?').get(granterId, viewerUserId) as { id: number; status: string } | undefined;
  if (existing) {
    if (existing.status === 'accepted') return { error: 'Already connected', status: 400 };
    if (existing.status === 'pending') return { error: 'Invite already pending', status: 400 };
  }

  db.prepare('INSERT INTO vacay_read_access (granter_id, viewer_id, status) VALUES (?, ?, ?)').run(granterId, viewerUserId, 'pending');

  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(viewerUserId, {
      type: 'vacay:access_invite',
      from: { id: granterId, username: granterUsername },
    });
  } catch { /* websocket not available */ }

  import('../services/notificationService').then(({ send }) => {
    send({ event: 'vacay_invite', actorId: granterId, scope: 'user', targetId: viewerUserId, params: { actor: granterEmail } }).catch(() => {});
  });

  return {};
}

export function acceptAccessInvite(viewerId: number, granterId: number, socketId: string | undefined): { error?: string; status?: number } {
  const invite = db.prepare("SELECT * FROM vacay_read_access WHERE granter_id = ? AND viewer_id = ? AND status = 'pending'").get(granterId, viewerId);
  if (!invite) return { error: 'No pending invite', status: 404 };

  // Accept the existing invite (granter → viewer)
  db.prepare("UPDATE vacay_read_access SET status = 'accepted' WHERE granter_id = ? AND viewer_id = ?").run(granterId, viewerId);
  // Create the reverse connection (viewer → granter) for bidirectionality
  db.prepare("INSERT OR IGNORE INTO vacay_read_access (granter_id, viewer_id, status) VALUES (?, ?, 'accepted')").run(viewerId, granterId);

  // Auto-assign unique colors if still at the default — include the other party in the
  // avoid-list so the two users always get distinct colors even on a first connection.
  const viewerPlan = getOwnPlan(viewerId);
  const granterPlan = getOwnPlan(granterId);
  assignUniqueColorIfDefault(viewerId, viewerPlan.id, [...getConnectedUserIds(granterId).filter(id => id !== viewerId), granterId]);
  assignUniqueColorIfDefault(granterId, granterPlan.id, [...getConnectedUserIds(viewerId).filter(id => id !== granterId), viewerId]);

  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(granterId, { type: 'vacay:access_accepted' }, socketId);
  } catch { /* websocket not available */ }

  return {};
}

export function declineAccessInvite(viewerId: number, granterId: number, socketId: string | undefined): void {
  db.prepare("DELETE FROM vacay_read_access WHERE granter_id = ? AND viewer_id = ? AND status = 'pending'").run(granterId, viewerId);

  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(granterId, { type: 'vacay:access_declined' }, socketId);
  } catch { /* websocket not available */ }
}

export function cancelAccessInvite(granterId: number, viewerUserId: number): void {
  db.prepare("DELETE FROM vacay_read_access WHERE granter_id = ? AND viewer_id = ? AND status = 'pending'").run(granterId, viewerUserId);

  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(viewerUserId, { type: 'vacay:access_cancelled' });
  } catch { /* websocket not available */ }
}

export function revokeAccess(requesterId: number, otherUserId: number, socketId: string | undefined): void {
  // Delete both directions (bidirectional connection)
  db.prepare(`
    DELETE FROM vacay_read_access
    WHERE (granter_id = ? AND viewer_id = ?) OR (granter_id = ? AND viewer_id = ?)
  `).run(requesterId, otherUserId, otherUserId, requesterId);

  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(otherUserId, { type: 'vacay:access_revoked' }, socketId);
    broadcastToUser(requesterId, { type: 'vacay:access_revoked' }, socketId);
  } catch { /* websocket not available */ }
}

// ---------------------------------------------------------------------------
// Read-access user lists
// ---------------------------------------------------------------------------

export function getAvailableUsersForAccess(granterId: number) {
  return db.prepare(`
    SELECT u.id, u.username, u.email FROM users u
    WHERE u.id != ?
    AND u.id NOT IN (
      SELECT viewer_id FROM vacay_read_access WHERE granter_id = ?
      UNION
      SELECT granter_id FROM vacay_read_access WHERE viewer_id = ?
    )
    ORDER BY u.username
  `).all(granterId, granterId, granterId);
}

export function getConnectedUsers(userId: number): (VacayUser & { color: string })[] {
  return db.prepare(`
    SELECT DISTINCT u.id, u.username, u.email, COALESCE(c.color, '#6366f1') as color
    FROM (
      SELECT viewer_id as other_id FROM vacay_read_access WHERE granter_id = ? AND status = 'accepted'
      UNION
      SELECT granter_id as other_id FROM vacay_read_access WHERE viewer_id = ? AND status = 'accepted'
    ) connected
    JOIN users u ON u.id = connected.other_id
    LEFT JOIN vacay_plans p ON p.owner_id = u.id
    LEFT JOIN vacay_user_colors c ON c.user_id = u.id AND c.plan_id = p.id
  `).all(userId, userId) as (VacayUser & { color: string })[];
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
    if (!plan) return listYears(planId);
    const carryOverEnabled = !!plan.carry_over_enabled;
    let carriedOver = 0;
    if (carryOverEnabled) {
      const prevConfig = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(plan.owner_id, planId, year - 1) as VacayUserYear | undefined;
      if (prevConfig) {
        const used = (db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(plan.owner_id, planId, `${year - 1}-%`) as { count: number }).count;
        const total = prevConfig.vacation_days + prevConfig.carried_over;
        carriedOver = Math.max(0, total - used);
      }
    }
    db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, ?)').run(plan.owner_id, planId, year, carriedOver);
  } catch { /* year already exists */ }
  notifyPlanOwnerAndViewers(planId, socketId, 'vacay:settings');
  return listYears(planId);
}

export function deleteYear(planId: number, year: number, socketId: string | undefined): number[] {
  db.prepare('DELETE FROM vacay_years WHERE plan_id = ? AND year = ?').run(planId, year);
  db.prepare("DELETE FROM vacay_entries WHERE plan_id = ? AND date LIKE ?").run(planId, `${year}-%`);
  db.prepare("DELETE FROM vacay_company_holidays WHERE plan_id = ? AND date LIKE ?").run(planId, `${year}-%`);
  db.prepare('DELETE FROM vacay_user_years WHERE plan_id = ? AND year = ?').run(planId, year);

  const nextYearExists = db.prepare('SELECT id FROM vacay_years WHERE plan_id = ? AND year = ?').get(planId, year + 1);
  if (nextYearExists) {
    const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
    if (plan) {
      const carryOverEnabled = !!plan.carry_over_enabled;
      const prevYear = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? AND year < ? ORDER BY year DESC LIMIT 1').get(planId, year + 1) as { year: number } | undefined;
      let carry = 0;
      if (carryOverEnabled && prevYear) {
        const prevConfig = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(plan.owner_id, planId, prevYear.year) as VacayUserYear | undefined;
        if (prevConfig) {
          const used = (db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(plan.owner_id, planId, `${prevYear.year}-%`) as { count: number }).count;
          const total = prevConfig.vacation_days + prevConfig.carried_over;
          carry = Math.max(0, total - used);
        }
      }
      db.prepare('UPDATE vacay_user_years SET carried_over = ? WHERE user_id = ? AND plan_id = ? AND year = ?').run(carry, plan.owner_id, planId, year + 1);
    }
  }

  notifyPlanOwnerAndViewers(planId, socketId, 'vacay:settings');
  return listYears(planId);
}

// ---------------------------------------------------------------------------
// Entries (own plan only)
// ---------------------------------------------------------------------------

export function getEntries(planId: number, year: string) {
  const plan = db.prepare('SELECT owner_id FROM vacay_plans WHERE id = ?').get(planId) as { owner_id: number } | undefined;
  if (!plan) return { entries: [], companyHolidays: [] };

  const entries = db.prepare(`
    SELECT e.*, u.username as person_name, COALESCE(c.color, '#6366f1') as person_color
    FROM vacay_entries e
    JOIN users u ON e.user_id = u.id
    LEFT JOIN vacay_user_colors c ON c.user_id = e.user_id AND c.plan_id = e.plan_id
    WHERE e.plan_id = ? AND e.user_id = ? AND e.date LIKE ?
  `).all(planId, plan.owner_id, `${year}-%`);

  const companyHolidays = db.prepare("SELECT * FROM vacay_company_holidays WHERE plan_id = ? AND date LIKE ?").all(planId, `${year}-%`);
  return { entries, companyHolidays };
}

export function toggleEntry(userId: number, planId: number, date: string, socketId: string | undefined): { action: string } {
  const existing = db.prepare('SELECT id FROM vacay_entries WHERE user_id = ? AND date = ? AND plan_id = ?').get(userId, date, planId) as { id: number } | undefined;
  if (existing) {
    db.prepare('DELETE FROM vacay_entries WHERE id = ?').run(existing.id);
    notifyPlanOwnerAndViewers(planId, socketId);
    return { action: 'removed' };
  } else {
    db.prepare('INSERT INTO vacay_entries (plan_id, user_id, date, note) VALUES (?, ?, ?, ?)').run(planId, userId, date, '');
    notifyPlanOwnerAndViewers(planId, socketId);
    return { action: 'added' };
  }
}

export function toggleCompanyHoliday(planId: number, date: string, note: string | undefined, socketId: string | undefined): { action: string } {
  const existing = db.prepare('SELECT id FROM vacay_company_holidays WHERE plan_id = ? AND date = ?').get(planId, date) as { id: number } | undefined;
  if (existing) {
    db.prepare('DELETE FROM vacay_company_holidays WHERE id = ?').run(existing.id);
    notifyPlanOwnerAndViewers(planId, socketId);
    return { action: 'removed' };
  } else {
    db.prepare('INSERT INTO vacay_company_holidays (plan_id, date, note) VALUES (?, ?, ?)').run(planId, date, note || '');
    db.prepare('DELETE FROM vacay_entries WHERE plan_id = ? AND date = ?').run(planId, date);
    notifyPlanOwnerAndViewers(planId, socketId);
    return { action: 'added' };
  }
}

// ---------------------------------------------------------------------------
// Foreign entries (from all accepted granters)
// ---------------------------------------------------------------------------

export function getForeignEntries(userId: number, year: string) {
  const granters = db.prepare(`
    SELECT ra.granter_id, u.username, COALESCE(c.color, '#6366f1') as color, p.id as plan_id
    FROM vacay_read_access ra
    JOIN users u ON ra.granter_id = u.id
    JOIN vacay_plans p ON p.owner_id = ra.granter_id
    LEFT JOIN vacay_user_colors c ON c.user_id = ra.granter_id AND c.plan_id = p.id
    WHERE ra.viewer_id = ? AND ra.status = 'accepted'
  `).all(userId) as { granter_id: number; username: string; color: string; plan_id: number }[];

  const entries: { date: string; user_id: number; person_name: string; person_color: string }[] = [];

  for (const g of granters) {
    // Vacation entries
    const vacationEntries = db.prepare(`
      SELECT date FROM vacay_entries WHERE plan_id = ? AND user_id = ? AND date LIKE ?
    `).all(g.plan_id, g.granter_id, `${year}-%`) as { date: string }[];
    for (const e of vacationEntries) {
      entries.push({ date: e.date, user_id: g.granter_id, person_name: g.username, person_color: g.color });
    }

    // Company holidays (Betriebsferien) — deduplicate per granter per date
    const companyHolidays = db.prepare(`
      SELECT date FROM vacay_company_holidays WHERE plan_id = ? AND date LIKE ?
    `).all(g.plan_id, `${year}-%`) as { date: string }[];
    for (const ch of companyHolidays) {
      if (!entries.some(e => e.date === ch.date && e.user_id === g.granter_id)) {
        entries.push({ date: ch.date, user_id: g.granter_id, person_name: g.username, person_color: g.color });
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Stats (own plan only)
// ---------------------------------------------------------------------------

export function getStats(planId: number, year: number) {
  const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
  if (!plan) return [];
  const carryOverEnabled = !!plan.carry_over_enabled;

  const used = (db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(plan.owner_id, planId, `${year}-%`) as { count: number }).count;
  const config = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(plan.owner_id, planId, year) as VacayUserYear | undefined;
  const vacationDays = config ? config.vacation_days : 30;
  const carriedOver = carryOverEnabled ? (config ? config.carried_over : 0) : 0;
  const total = vacationDays + carriedOver;
  const remaining = total - used;
  const colorRow = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(plan.owner_id, planId) as { color: string } | undefined;
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(plan.owner_id) as { username: string };

  const nextYearExists = db.prepare('SELECT id FROM vacay_years WHERE plan_id = ? AND year = ?').get(planId, year + 1);
  if (nextYearExists && carryOverEnabled) {
    const carry = Math.max(0, remaining);
    db.prepare(`
      INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, ?)
      ON CONFLICT(user_id, plan_id, year) DO UPDATE SET carried_over = ?
    `).run(plan.owner_id, planId, year + 1, carry, carry);
  }

  return [{
    user_id: plan.owner_id, person_name: owner.username, person_color: colorRow?.color || '#6366f1',
    year, vacation_days: vacationDays, carried_over: carriedOver,
    total_available: total, used, remaining,
  }];
}

export function updateStats(userId: number, planId: number, year: number, vacationDays: number, socketId: string | undefined): void {
  db.prepare(`
    INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(user_id, plan_id, year) DO UPDATE SET vacation_days = excluded.vacation_days
  `).run(userId, planId, year, vacationDays);
  notifyPlanOwnerAndViewers(planId, socketId);
}

// ---------------------------------------------------------------------------
// GET /plan composite
// ---------------------------------------------------------------------------

export function getAllStats(userId: number, year: number) {
  const ownPlan = getOwnPlan(userId);
  const ownStats = getStats(ownPlan.id, year).map(s => ({ ...s, canEdit: true }));

  const granters = db.prepare(`
    SELECT granter_id FROM vacay_read_access WHERE viewer_id = ? AND status = 'accepted'
  `).all(userId) as { granter_id: number }[];

  const allStats = [...ownStats];
  for (const { granter_id } of granters) {
    const granterPlan = getOwnPlan(granter_id);
    allStats.push(...getStats(granterPlan.id, year).map(s => ({ ...s, canEdit: false })));
  }

  return allStats;
}

export function getPlanData(userId: number) {
  const plan = getOwnPlan(userId);
  const planId = plan.id;

  const colorRow = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(userId, planId) as { color: string } | undefined;
  const myColor = colorRow?.color || '#6366f1';

  const holidayCalendars = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ? ORDER BY sort_order, id').all(planId) as VacayHolidayCalendar[];

  const connectedUsers = getConnectedUsers(userId);

  const pendingIncoming = db.prepare(`
    SELECT ra.id, ra.granter_id, u.username as granter_username
    FROM vacay_read_access ra
    JOIN users u ON ra.granter_id = u.id
    WHERE ra.viewer_id = ? AND ra.status = 'pending'
  `).all(userId);

  const pendingOutgoing = db.prepare(`
    SELECT ra.id, ra.viewer_id, u.username as viewer_username
    FROM vacay_read_access ra
    JOIN users u ON ra.viewer_id = u.id
    WHERE ra.granter_id = ? AND ra.status = 'pending'
  `).all(userId);

  return {
    plan: {
      ...plan,
      block_weekends: !!plan.block_weekends,
      holidays_enabled: !!plan.holidays_enabled,
      company_holidays_enabled: !!plan.company_holidays_enabled,
      carry_over_enabled: !!plan.carry_over_enabled,
      holiday_calendars: holidayCalendars,
    },
    myColor,
    connectedUsers,
    pendingIncoming,
    pendingOutgoing,
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
