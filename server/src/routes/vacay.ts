import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import * as svc from '../services/vacayService';

const router = express.Router();
router.use(authenticate);

router.get('/plan', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json(svc.getPlanData(authReq.user.id));
});

router.put('/plan', async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const planId = svc.getActivePlanId(authReq.user.id);
  const result = await svc.updatePlan(planId, req.body, req.headers['x-socket-id'] as string);
  res.json(result);
});

router.post('/plan/holiday-calendars', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { region, label, color, sort_order } = req.body;
  if (!region) return res.status(400).json({ error: 'region required' });
  const planId = svc.getActivePlanId(authReq.user.id);
  const calendar = svc.addHolidayCalendar(planId, region, label, color, sort_order, req.headers['x-socket-id'] as string);
  res.json({ calendar });
});

router.put('/plan/holiday-calendars/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const id = parseInt(req.params.id);
  const planId = svc.getActivePlanId(authReq.user.id);
  const calendar = svc.updateHolidayCalendar(id, planId, req.body, req.headers['x-socket-id'] as string);
  if (!calendar) return res.status(404).json({ error: 'Calendar not found' });
  res.json({ calendar });
});

router.delete('/plan/holiday-calendars/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const id = parseInt(req.params.id);
  const planId = svc.getActivePlanId(authReq.user.id);
  const deleted = svc.deleteHolidayCalendar(id, planId, req.headers['x-socket-id'] as string);
  if (!deleted) return res.status(404).json({ error: 'Calendar not found' });
  res.json({ success: true });
});

router.put('/color', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { color, target_user_id } = req.body;
  const planId = svc.getActivePlanId(authReq.user.id);
  const userId = target_user_id ? parseInt(target_user_id) : authReq.user.id;
  const planUsers = svc.getPlanUsers(planId);
  if (!planUsers.find(u => u.id === userId)) {
    return res.status(403).json({ error: 'User not in plan' });
  }
  svc.setUserColor(userId, planId, color, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

router.post('/invite', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const plan = svc.getActivePlan(authReq.user.id);
  const result = svc.sendInvite(plan.id, authReq.user.id, authReq.user.username, authReq.user.email, user_id);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ success: true });
});

router.post('/invite/accept', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { plan_id } = req.body;
  const result = svc.acceptInvite(authReq.user.id, plan_id, req.headers['x-socket-id'] as string);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ success: true });
});

router.post('/invite/decline', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { plan_id } = req.body;
  svc.declineInvite(authReq.user.id, plan_id, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

router.post('/invite/cancel', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { user_id } = req.body;
  const plan = svc.getActivePlan(authReq.user.id);
  svc.cancelInvite(plan.id, user_id);
  res.json({ success: true });
});

router.post('/dissolve', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  svc.dissolvePlan(authReq.user.id, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

router.get('/available-users', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const planId = svc.getActivePlanId(authReq.user.id);
  const users = svc.getAvailableUsers(authReq.user.id, planId);
  res.json({ users });
});

router.get('/years', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const planId = svc.getActivePlanId(authReq.user.id);
  res.json({ years: svc.listYears(planId) });
});

router.post('/years', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { year } = req.body;
  if (!year) return res.status(400).json({ error: 'Year required' });
  const planId = svc.getActivePlanId(authReq.user.id);
  const years = svc.addYear(planId, year, req.headers['x-socket-id'] as string);
  res.json({ years });
});

router.delete('/years/:year', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const year = parseInt(req.params.year);
  const planId = svc.getActivePlanId(authReq.user.id);
  const years = svc.deleteYear(planId, year, req.headers['x-socket-id'] as string);
  res.json({ years });
});

router.get('/entries/:year', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const planId = svc.getActivePlanId(authReq.user.id);
  res.json(svc.getEntries(planId, req.params.year));
});

router.post('/entries/toggle', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { date, target_user_id } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  const planId = svc.getActivePlanId(authReq.user.id);
  let userId = authReq.user.id;
  if (target_user_id && parseInt(target_user_id) !== authReq.user.id) {
    const planUsers = svc.getPlanUsers(planId);
    const tid = parseInt(target_user_id);
    if (!planUsers.find(u => u.id === tid)) {
      return res.status(403).json({ error: 'User not in plan' });
    }
    userId = tid;
  }
  res.json(svc.toggleEntry(userId, planId, date, req.headers['x-socket-id'] as string));
});

router.post('/entries/company-holiday', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { date, note, target_user_id } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  const planId = svc.getActivePlanId(authReq.user.id);
  let userId = authReq.user.id;
  if (target_user_id && parseInt(target_user_id) !== authReq.user.id) {
    const planUsers = svc.getPlanUsers(planId);
    const tid = parseInt(target_user_id);
    if (!planUsers.find(u => u.id === tid)) {
      return res.status(403).json({ error: 'User not in plan' });
    }
    userId = tid;
  }
  res.json(svc.toggleCompanyHoliday(userId, planId, date, note, req.headers['x-socket-id'] as string));
});

router.get('/stats/:year', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const year = parseInt(req.params.year);
  const planId = svc.getActivePlanId(authReq.user.id);
  res.json({ stats: svc.getStats(planId, year) });
});

router.put('/stats/:year', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const year = parseInt(req.params.year);
  const { vacation_days, target_user_id } = req.body;
  const planId = svc.getActivePlanId(authReq.user.id);
  const userId = target_user_id ? parseInt(target_user_id) : authReq.user.id;
  const planUsers = svc.getPlanUsers(planId);
  if (!planUsers.find(u => u.id === userId)) {
    return res.status(403).json({ error: 'User not in plan' });
  }
  svc.updateStats(userId, planId, year, vacation_days, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

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
