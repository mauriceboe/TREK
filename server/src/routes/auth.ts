import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import { authenticate, optionalAuth, demoUploadBlock } from '../middleware/auth';
import { AuthRequest, OptionalAuthRequest } from '../types';
import { writeAudit, getClientIp } from '../services/auditLog';
import { setAuthCookie, clearAuthCookie } from '../services/cookie';
import {
  getAppConfig,
  demoLogin,
  validateInviteToken,
  registerUser,
  loginUser,
  getCurrentUser,
  changePassword,
  deleteAccount,
  updateMapsKey,
  updateApiKeys,
  updateSettings,
  getSettings,
  saveAvatar,
  deleteAvatar,
  listUsers,
  validateKeys,
  getAppSettings,
  updateAppSettings,
  getTravelStats,
  setupMfa,
  enableMfa,
  disableMfa,
  verifyMfaLogin,
  listMcpTokens,
  createMcpToken,
  deleteMcpToken,
  createWsToken,
  createResourceToken,
} from '../services/authService';

const router = express.Router();

// ---------------------------------------------------------------------------
// Avatar upload (multer config stays in route — middleware concern)
// ---------------------------------------------------------------------------

const avatarDir = path.join(__dirname, '../../uploads/avatars');
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, avatarDir),
  filename: (_req, file, cb) => cb(null, uuid() + path.extname(file.originalname)),
});
const ALLOWED_AVATAR_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: MAX_AVATAR_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!file.mimetype.startsWith('image/') || !ALLOWED_AVATAR_EXTS.includes(ext)) {
      return cb(null, false);
    }
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// Rate limiter (middleware concern — stays in route)
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_CLEANUP = 5 * 60 * 1000;

const loginAttempts = new Map<string, { count: number; first: number }>();
const mfaAttempts = new Map<string, { count: number; first: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of loginAttempts) {
    if (now - record.first >= RATE_LIMIT_WINDOW) loginAttempts.delete(key);
  }
  for (const [key, record] of mfaAttempts) {
    if (now - record.first >= RATE_LIMIT_WINDOW) mfaAttempts.delete(key);
  }
}, RATE_LIMIT_CLEANUP);

function rateLimiter(maxAttempts: number, windowMs: number, store = loginAttempts) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const record = store.get(key);
    if (record && record.count >= maxAttempts && now - record.first < windowMs) {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    if (!record || now - record.first >= windowMs) {
      store.set(key, { count: 1, first: now });
    } else {
      record.count++;
    }
    next();
  };
}
const authLimiter = rateLimiter(10, RATE_LIMIT_WINDOW);
const mfaLimiter = rateLimiter(5, RATE_LIMIT_WINDOW, mfaAttempts);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/app-config', optionalAuth, (req: Request, res: Response) => {
  const user = (req as OptionalAuthRequest).user;
  res.json(getAppConfig(user));
});

router.post('/demo-login', (_req: Request, res: Response) => {
  const result = demoLogin();
  if (result.error) return res.status(result.status!).json({ error: result.error });
  setAuthCookie(res, result.token!);
  res.json({ token: result.token, user: result.user });
});

router.get('/invite/:token', authLimiter, (req: Request, res: Response) => {
  const result = validateInviteToken(req.params.token);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ valid: result.valid, max_uses: result.max_uses, used_count: result.used_count, expires_at: result.expires_at });
});

router.post('/register', authLimiter, (req: Request, res: Response) => {
  const result = registerUser(req.body);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  writeAudit({ userId: result.auditUserId!, action: 'user.register', ip: getClientIp(req), details: result.auditDetails });
  setAuthCookie(res, result.token!);
  res.status(201).json({ token: result.token, user: result.user });
});

router.post('/login', authLimiter, (req: Request, res: Response) => {
  const result = loginUser(req.body);
  if (result.auditAction) {
    writeAudit({ userId: result.auditUserId ?? null, action: result.auditAction, ip: getClientIp(req), details: result.auditDetails });
  }
  if (result.error) return res.status(result.status!).json({ error: result.error });
  if (result.mfa_required) return res.json({ mfa_required: true, mfa_token: result.mfa_token });
  setAuthCookie(res, result.token!);
  res.json({ token: result.token, user: result.user });
});

router.get('/me', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const user = getCurrentUser(authReq.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

router.post('/logout', (_req: Request, res: Response) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

router.put('/me/password', authenticate, rateLimiter(5, RATE_LIMIT_WINDOW), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = changePassword(authReq.user.id, authReq.user.email, req.body);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  writeAudit({ userId: authReq.user.id, action: 'user.password_change', ip: getClientIp(req) });
  res.json({ success: true });
});

router.delete('/me', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = deleteAccount(authReq.user.id, authReq.user.email, authReq.user.role);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  writeAudit({ userId: authReq.user.id, action: 'user.account_delete', ip: getClientIp(req) });
  res.json({ success: true });
});

router.put('/me/maps-key', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json(updateMapsKey(authReq.user.id, req.body.maps_api_key));
});

router.put('/me/api-keys', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json(updateApiKeys(authReq.user.id, req.body));
});

router.put('/me/settings', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = updateSettings(authReq.user.id, req.body);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ success: result.success, user: result.user });
});

router.get('/me/settings', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = getSettings(authReq.user.id);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ settings: result.settings });
});

router.post('/avatar', authenticate, demoUploadBlock, avatarUpload.single('avatar'), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  res.json(saveAvatar(authReq.user.id, req.file.filename));
});

router.delete('/avatar', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json(deleteAvatar(authReq.user.id));
});

router.get('/users', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json({ users: listUsers(authReq.user.id) });
});

router.get('/validate-keys', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = await validateKeys(authReq.user.id);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ maps: result.maps, weather: result.weather, maps_details: result.maps_details });
});

router.get('/app-settings', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = getAppSettings(authReq.user.id);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json(result.data);
});

router.put('/app-settings', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = updateAppSettings(authReq.user.id, req.body);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  writeAudit({
    userId: authReq.user.id,
    action: 'settings.app_update',
    ip: getClientIp(req),
    details: result.auditSummary,
    debugDetails: result.auditDebugDetails,
  });
  res.json({ success: true });
});

router.get('/travel-stats', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json(getTravelStats(authReq.user.id));
});

router.post('/mfa/verify-login', mfaLimiter, (req: Request, res: Response) => {
  const result = verifyMfaLogin(req.body);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  writeAudit({ userId: result.auditUserId!, action: 'user.login', ip: getClientIp(req), details: { mfa: true } });
  setAuthCookie(res, result.token!);
  res.json({ token: result.token, user: result.user });
});

router.post('/mfa/setup', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = setupMfa(authReq.user.id, authReq.user.email);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  result.qrPromise!
    .then((qr_data_url: string) => {
      res.json({ secret: result.secret, otpauth_url: result.otpauth_url, qr_data_url });
    })
    .catch((err: unknown) => {
      console.error('[MFA] QR code generation error:', err);
      res.status(500).json({ error: 'Could not generate QR code' });
    });
});

router.post('/mfa/enable', authenticate, mfaLimiter, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = enableMfa(authReq.user.id, req.body.code);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  writeAudit({ userId: authReq.user.id, action: 'user.mfa_enable', ip: getClientIp(req) });
  res.json({ success: true, mfa_enabled: result.mfa_enabled, backup_codes: result.backup_codes });
});

router.post('/mfa/disable', authenticate, rateLimiter(5, RATE_LIMIT_WINDOW), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = disableMfa(authReq.user.id, authReq.user.email, req.body);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  writeAudit({ userId: authReq.user.id, action: 'user.mfa_disable', ip: getClientIp(req) });
  res.json({ success: true, mfa_enabled: result.mfa_enabled });
});

// --- MCP Token Management ---

router.get('/mcp-tokens', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json({ tokens: listMcpTokens(authReq.user.id) });
});

router.post('/mcp-tokens', authenticate, rateLimiter(5, RATE_LIMIT_WINDOW), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = createMcpToken(authReq.user.id, req.body.name);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.status(201).json({ token: result.token });
});

router.delete('/mcp-tokens/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = deleteMcpToken(authReq.user.id, req.params.id);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ success: true });
});

// Short-lived single-use token for WebSocket connections
router.post('/ws-token', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = createWsToken(authReq.user.id);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ token: result.token });
});

// Short-lived single-use token for direct resource URLs
router.post('/resource-token', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = createResourceToken(authReq.user.id, req.body.purpose);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ token: result.token });
});

export default router;

// Exported for test resets only — do not use in production code
export { loginAttempts, mfaAttempts };
