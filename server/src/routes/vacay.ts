import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import * as svc from '../services/vacayService';

const router = express.Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Plan (own plan always)
// ---------------------------------------------------------------------------

router.get('/plan', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json(svc.getPlanData(authReq.user.id));
});

router.put('/plan', async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const plan = svc.getOwnPlan(authReq.user.id);
  const result = await svc.updatePlan(plan.id, req.body, req.headers['x-socket-id'] as string);
  res.json(result);
});

router.post('/plan/holiday-calendars', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { region, label, color, sort_order } = req.body;
  if (!region) return res.status(400).json({ error: 'region required' });
  const plan = svc.getOwnPlan(authReq.user.id);
  const calendar = svc.addHolidayCalendar(plan.id, region, label, color, sort_order, req.headers['x-socket-id'] as string);
  res.json({ calendar });
});

router.put('/plan/holiday-calendars/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const id = parseInt(req.params.id);
  const plan = svc.getOwnPlan(authReq.user.id);
  const calendar = svc.updateHolidayCalendar(id, plan.id, req.body, req.headers['x-socket-id'] as string);
  if (!calendar) return res.status(404).json({ error: 'Calendar not found' });
  res.json({ calendar });
});

router.delete('/plan/holiday-calendars/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const id = parseInt(req.params.id);
  const plan = svc.getOwnPlan(authReq.user.id);
  const deleted = svc.deleteHolidayCalendar(id, plan.id, req.headers['x-socket-id'] as string);
  if (!deleted) return res.status(404).json({ error: 'Calendar not found' });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// User color (own plan only)
// ---------------------------------------------------------------------------

router.put('/color', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { color } = req.body;
  const plan = svc.getOwnPlan(authReq.user.id);
  svc.setUserColor(authReq.user.id, plan.id, color, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Read-access management
// ---------------------------------------------------------------------------

router.post('/access/grant', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { viewer_id } = req.body;
  if (!viewer_id) return res.status(400).json({ error: 'viewer_id required' });
  const result = svc.grantAccess(authReq.user.id, authReq.user.username, authReq.user.email, parseInt(viewer_id));
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ success: true });
});

router.post('/access/accept', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { granter_id } = req.body;
  if (!granter_id) return res.status(400).json({ error: 'granter_id required' });
  const result = svc.acceptAccessInvite(authReq.user.id, parseInt(granter_id), req.headers['x-socket-id'] as string);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ success: true });
});

router.post('/access/decline', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { granter_id } = req.body;
  if (!granter_id) return res.status(400).json({ error: 'granter_id required' });
  svc.declineAccessInvite(authReq.user.id, parseInt(granter_id), req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

router.post('/access/cancel', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { viewer_id } = req.body;
  if (!viewer_id) return res.status(400).json({ error: 'viewer_id required' });
  svc.cancelAccessInvite(authReq.user.id, parseInt(viewer_id));
  res.json({ success: true });
});

router.delete('/access/:userId', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const otherUserId = parseInt(req.params.userId);
  svc.revokeAccess(authReq.user.id, otherUserId, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

router.get('/access/available-users', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const users = svc.getAvailableUsersForAccess(authReq.user.id);
  res.json({ users });
});

router.get('/access/foreign-entries/:year', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const entries = svc.getForeignEntries(authReq.user.id, req.params.year);
  res.json({ entries });
});

// ---------------------------------------------------------------------------
// Years
// ---------------------------------------------------------------------------

router.get('/years', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const plan = svc.getOwnPlan(authReq.user.id);
  res.json({ years: svc.listYears(plan.id) });
});

router.post('/years', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { year } = req.body;
  if (!year) return res.status(400).json({ error: 'Year required' });
  const plan = svc.getOwnPlan(authReq.user.id);
  const years = svc.addYear(plan.id, year, req.headers['x-socket-id'] as string);
  res.json({ years });
});

router.delete('/years/:year', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const year = parseInt(req.params.year);
  const plan = svc.getOwnPlan(authReq.user.id);
  const years = svc.deleteYear(plan.id, year, req.headers['x-socket-id'] as string);
  res.json({ years });
});

// ---------------------------------------------------------------------------
// Entries (own plan)
// ---------------------------------------------------------------------------

router.get('/entries/:year', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const plan = svc.getOwnPlan(authReq.user.id);
  res.json(svc.getEntries(plan.id, req.params.year));
});

router.post('/entries/toggle', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  const plan = svc.getOwnPlan(authReq.user.id);
  res.json(svc.toggleEntry(authReq.user.id, plan.id, date, req.headers['x-socket-id'] as string));
});

router.post('/entries/company-holiday', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { date, note } = req.body;
  const plan = svc.getOwnPlan(authReq.user.id);
  res.json(svc.toggleCompanyHoliday(plan.id, date, note, req.headers['x-socket-id'] as string));
});

// ---------------------------------------------------------------------------
// Stats (own plan)
// ---------------------------------------------------------------------------

router.get('/stats/:year', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const year = parseInt(req.params.year);
  res.json({ stats: svc.getAllStats(authReq.user.id, year) });
});

router.put('/stats/:year', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const year = parseInt(req.params.year);
  const { vacation_days } = req.body;
  const plan = svc.getOwnPlan(authReq.user.id);
  svc.updateStats(authReq.user.id, plan.id, year, vacation_days, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Public holidays proxy (nager.at)
// ---------------------------------------------------------------------------

router.get('/holidays/countries', async (_req: Request, res: Response) => {
  const result = await svc.getCountries();
  if (result.error) return res.status(502).json({ error: result.error });
  res.json(result.data);
});

router.get('/holidays/:year/:country', async (req: Request, res: Response) => {
  const { year, country } = req.params;
  const result = await svc.getHolidays(year, country);
  if (result.error) return res.status(502).json({ error: result.error });
  res.json(result.data);
});

export default router;
