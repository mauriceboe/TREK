import express, { Request, Response } from 'express';
import { authenticate, adminOnly } from '../middleware/auth';
import { AuthRequest } from '../types';
import { writeAudit, getClientIp, logInfo } from '../services/auditLog';
import * as svc from '../services/adminService';
import { invalidateMcpSessions } from '../mcp';
import { getPreferencesMatrix, setAdminPreferences } from '../services/notificationPreferencesService';

const router = express.Router();

router.use(authenticate, adminOnly);

// ── User CRUD ──────────────────────────────────────────────────────────────

router.get('/users', (_req: Request, res: Response) => {
  res.json({ users: svc.listUsers() });
});

router.post('/users', (req: Request, res: Response) => {
  const result = svc.createUser(req.body);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.user_create',
    resource: String(result.insertedId),
    ip: getClientIp(req),
    details: result.auditDetails,
  });
  res.status(201).json({ user: result.user });
});

router.put('/users/:id', (req: Request, res: Response) => {
  const result = svc.updateUser(req.params.id, req.body);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.user_update',
    resource: String(req.params.id),
    ip: getClientIp(req),
    details: { targetUser: result.previousEmail, fields: result.changed },
  });
  logInfo(`Admin ${authReq.user.email} edited user ${result.previousEmail} (fields: ${result.changed.join(', ')})`);
  res.json({ user: result.user });
});

router.delete('/users/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = svc.deleteUser(req.params.id, authReq.user.id);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.user_delete',
    resource: String(req.params.id),
    ip: getClientIp(req),
    details: { targetUser: result.email },
  });
  logInfo(`Admin ${authReq.user.email} deleted user ${result.email}`);
  res.json({ success: true });
});

// ── Stats ──────────────────────────────────────────────────────────────────

router.get('/stats', (_req: Request, res: Response) => {
  res.json(svc.getStats());
});

// ── Permissions ────────────────────────────────────────────────────────────

router.get('/permissions', (_req: Request, res: Response) => {
  res.json(svc.getPermissions());
});

router.put('/permissions', (req: Request, res: Response) => {
  const { permissions } = req.body;
  if (!permissions || typeof permissions !== 'object') {
    return res.status(400).json({ error: 'permissions object required' });
  }
  const authReq = req as AuthRequest;
  const result = svc.savePermissions(permissions);
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.permissions_update',
    resource: 'permissions',
    ip: getClientIp(req),
    details: permissions,
  });
  res.json({ success: true, permissions: result.permissions, ...(result.skipped.length ? { skipped: result.skipped } : {}) });
});

// ── Audit Log ──────────────────────────────────────────────────────────────

router.get('/audit-log', (req: Request, res: Response) => {
  res.json(svc.getAuditLog(req.query as { limit?: string; offset?: string }));
});

// ── OIDC Settings ──────────────────────────────────────────────────────────

router.get('/oidc', (_req: Request, res: Response) => {
  res.json(svc.getOidcSettings());
});

router.put('/oidc', (req: Request, res: Response) => {
  const result = svc.updateOidcSettings(req.body);
  if (result.error) {
    return res.status(result.status || 400).json({ error: result.error });
  }
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.oidc_update',
    ip: getClientIp(req),
    details: { issuer_set: !!req.body.issuer },
  });
  res.json({ success: true });
});

// ── Demo Baseline ──────────────────────────────────────────────────────────

router.post('/save-demo-baseline', (req: Request, res: Response) => {
  const result = svc.saveDemoBaseline();
  if (result.error) return res.status(result.status!).json({ error: result.error });
  const authReq = req as AuthRequest;
  writeAudit({ userId: authReq.user.id, action: 'admin.demo_baseline_save', ip: getClientIp(req) });
  res.json({ success: true, message: result.message });
});

// ── GitHub / Version ───────────────────────────────────────────────────────

router.get('/github-releases', async (req: Request, res: Response) => {
  const { per_page = '10', page = '1' } = req.query;
  res.json(await svc.getGithubReleases(String(per_page), String(page)));
});

router.get('/version-check', async (_req: Request, res: Response) => {
  res.json(await svc.checkVersion());
});

// ── Admin notification preferences ────────────────────────────────────────

router.get('/notification-preferences', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json(getPreferencesMatrix(authReq.user.id, authReq.user.role, 'admin'));
});

router.put('/notification-preferences', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  setAdminPreferences(authReq.user.id, req.body);
  res.json(getPreferencesMatrix(authReq.user.id, authReq.user.role, 'admin'));
});

// ── Invite Tokens ──────────────────────────────────────────────────────────

router.get('/invites', (_req: Request, res: Response) => {
  res.json({ invites: svc.listInvites() });
});

router.post('/invites', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = svc.createInvite(authReq.user.id, req.body);
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.invite_create',
    resource: String(result.inviteId),
    ip: getClientIp(req),
    details: { max_uses: result.uses, expires_in_days: result.expiresInDays },
  });
  res.status(201).json({ invite: result.invite });
});

router.delete('/invites/:id', (req: Request, res: Response) => {
  const result = svc.deleteInvite(req.params.id);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.invite_delete',
    resource: String(req.params.id),
    ip: getClientIp(req),
  });
  res.json({ success: true });
});

// ── Bag Tracking ───────────────────────────────────────────────────────────

router.get('/bag-tracking', (_req: Request, res: Response) => {
  res.json(svc.getBagTracking());
});

router.put('/bag-tracking', (req: Request, res: Response) => {
  const result = svc.updateBagTracking(req.body.enabled);
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.bag_tracking',
    ip: getClientIp(req),
    details: { enabled: result.enabled },
  });
  res.json(result);
});

// ── Collab Features ───────────────────────────────────────────────────────

router.get('/collab-features', (_req: Request, res: Response) => {
  res.json(svc.getCollabFeatures());
});

router.put('/collab-features', (req: Request, res: Response) => {
  const result = svc.updateCollabFeatures(req.body);
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.collab_features',
    ip: getClientIp(req),
    details: result,
  });
  res.json(result);
});

// ── Packing Templates ──────────────────────────────────────────────────────

router.get('/packing-templates', (_req: Request, res: Response) => {
  res.json({ templates: svc.listPackingTemplates() });
});

router.get('/packing-templates/:id', (req: Request, res: Response) => {
  const result = svc.getPackingTemplate(req.params.id);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  res.json(result);
});

router.post('/packing-templates', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = svc.createPackingTemplate(req.body.name, authReq.user.id);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  res.status(201).json(result);
});

router.put('/packing-templates/:id', (req: Request, res: Response) => {
  const result = svc.updatePackingTemplate(req.params.id, req.body);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  res.json(result);
});

router.delete('/packing-templates/:id', (req: Request, res: Response) => {
  const result = svc.deletePackingTemplate(req.params.id);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.packing_template_delete',
    resource: String(req.params.id),
    ip: getClientIp(req),
    details: { name: result.name },
  });
  res.json({ success: true });
});

// Template categories

router.post('/packing-templates/:id/categories', (req: Request, res: Response) => {
  const result = svc.createTemplateCategory(req.params.id, req.body.name);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  res.status(201).json(result);
});

router.put('/packing-templates/:templateId/categories/:catId', (req: Request, res: Response) => {
  const result = svc.updateTemplateCategory(req.params.templateId, req.params.catId, req.body);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  res.json(result);
});

router.delete('/packing-templates/:templateId/categories/:catId', (req: Request, res: Response) => {
  const result = svc.deleteTemplateCategory(req.params.templateId, req.params.catId);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  res.json({ success: true });
});

// Template items

router.post('/packing-templates/:templateId/categories/:catId/items', (req: Request, res: Response) => {
  const result = svc.createTemplateItem(req.params.templateId, req.params.catId, req.body.name);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  res.status(201).json(result);
});

router.put('/packing-templates/:templateId/items/:itemId', (req: Request, res: Response) => {
  const result = svc.updateTemplateItem(req.params.itemId, req.body);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  res.json(result);
});

router.delete('/packing-templates/:templateId/items/:itemId', (req: Request, res: Response) => {
  const result = svc.deleteTemplateItem(req.params.itemId);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  res.json({ success: true });
});

// ── Addons ─────────────────────────────────────────────────────────────────

router.get('/addons', (_req: Request, res: Response) => {
  res.json({ addons: svc.listAddons() });
});

router.put('/addons/:id', (req: Request, res: Response) => {
  const result = svc.updateAddon(req.params.id, req.body);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.addon_update',
    resource: String(req.params.id),
    ip: getClientIp(req),
    details: result.auditDetails,
  });
  // Invalidate all MCP sessions so they re-create with the updated addon tool set
  invalidateMcpSessions();
  res.json({ addon: result.addon });
});

// ── MCP Tokens ─────────────────────────────────────────────────────────────

router.get('/mcp-tokens', (_req: Request, res: Response) => {
  res.json({ tokens: svc.listMcpTokens() });
});

router.delete('/mcp-tokens/:id', (req: Request, res: Response) => {
  const result = svc.deleteMcpToken(req.params.id);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  res.json({ success: true });
});

// ── OAuth Sessions ─────────────────────────────────────────────────────────

router.get('/oauth-sessions', (_req: Request, res: Response) => {
  res.json({ sessions: svc.listOAuthSessions() });
});

router.delete('/oauth-sessions/:id', (req: Request, res: Response) => {
  const result = svc.revokeOAuthSession(req.params.id);
  if ('error' in result) return res.status(result.status!).json({ error: result.error });
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.oauth_session.revoke',
    resource: String(req.params.id),
    ip: getClientIp(req),
  });
  res.json({ success: true });
});

// ── JWT Rotation ───────────────────────────────────────────────────────────

router.post('/rotate-jwt-secret', (req: Request, res: Response) => {
  const result = svc.rotateJwtSecret();
  if (result.error) return res.status(result.status!).json({ error: result.error });
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.rotate_jwt_secret',
    ip: getClientIp(req),
  });
  res.json({ success: true });
});

// ── Dev-only: test notification endpoints ──────────────────────────────────────
if (process.env.NODE_ENV === 'development') {
  const { send } = require('../services/notificationService');

  router.post('/dev/test-notification', async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { event = 'trip_reminder', scope = 'user', targetId, params = {}, inApp } = req.body;

    try {
      await send({
        event,
        actorId: authReq.user.id,
        scope,
        targetId: targetId ?? authReq.user.id,
        params: { actor: authReq.user.email, ...params },
        inApp,
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
}

export default router;
