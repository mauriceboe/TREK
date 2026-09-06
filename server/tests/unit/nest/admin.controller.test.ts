import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';

vi.mock('../../../src/nest/audit/client-ip', () => ({ getClientIp: vi.fn(() => '1.2.3.4') }));
vi.mock('../../../src/nest/audit/audit-log.logger', () => ({ LOG_LEVEL: 'error', logInfo: vi.fn(), logDebug: vi.fn(), logError: vi.fn(), logWarn: vi.fn() }));

import type { AddonsService } from '../../../src/nest/addons/addons.service';
import { AdminController } from '../../../src/nest/admin/admin.controller';
import type { TokenService } from '../../../src/nest/tokens/token.service';
import type { RegistrationInvitesService } from '../../../src/nest/auth/registration-invites.service';
import type { OauthService } from '../../../src/nest/oauth/oauth.service';
import type { AdminService } from '../../../src/nest/admin/admin.service';
import type { PluginRuntimeService } from '../../../src/nest/plugins/plugin-runtime.service';
import type { AuditService } from '../../../src/nest/audit/audit.service';
import type { NotificationsService } from '../../../src/nest/notifications/notifications.service';
import type { User } from '../../../src/types';

const user = { id: 1, role: 'admin', email: 'admin@example.test' } as User;
const req = { headers: {} } as Request;

function svc(o: Partial<AdminService> = {}): AdminService {
  return { invalidateMcpSessions: vi.fn(), ...o } as unknown as AdminService;
}

// AuditService is constructor-injected since the auditLog DI migration; the
// wrapper keeps the historical construction sites positional.
const writeAudit = vi.fn();
const audit = { writeAudit } as unknown as AuditService;
// Notifications are a constructor-injected stub since the notifications fold
// (same behavior as the old services/notificationService path mock).
const sendNotification = vi.fn().mockResolvedValue(undefined);
const notifications = { send: sendNotification } as unknown as NotificationsService;
/** The flags live on AddonsService now; the toggle routes reach it directly. */
const addonsStub = () => ({
  getBagTracking: vi.fn(() => ({ enabled: false })),
  updateBagTracking: vi.fn((enabled: boolean) => ({ enabled })),
  getPlacesPhotos: vi.fn(() => ({ enabled: false })),
  updatePlacesPhotos: vi.fn((enabled: boolean) => ({ enabled })),
  getPlacesAutocomplete: vi.fn(() => ({ enabled: false })),
  updatePlacesAutocomplete: vi.fn((enabled: boolean) => ({ enabled })),
  getPlacesDetails: vi.fn(() => ({ enabled: false })),
  updatePlacesDetails: vi.fn((enabled: boolean) => ({ enabled })),
  // Fail-closed with nothing to backfill — see AddonsService.getPlaceShadow.
  getPlaceShadow: vi.fn(() => ({ enabled: false })),
  updatePlaceShadow: vi.fn((enabled: boolean) => ({ enabled })),
  // Fail-open, unlike its three neighbours — see AddonsService.getPlacesEnrich.
  getPlacesEnrich: vi.fn(() => ({ enabled: true })),
  updatePlacesEnrich: vi.fn((enabled: boolean) => ({ enabled })),
  getCollabFeatures: vi.fn(() => ({ chat: false })),
  updateCollabFeatures: vi.fn(() => ({ features: { chat: true }, changed: true })),
}) as unknown as AddonsService;

// The MCP-token routes read TokenService now, not AdminService. Stubbed via a
// fourth, optional argument so every existing call site stays as it was.
const adminCtl = (s: AdminService, rt?: PluginRuntimeService, addons: AddonsService = addonsStub(), tokens: Partial<TokenService> = {}, invites: Partial<RegistrationInvitesService> = {}, oauth: Partial<OauthService> = {}) =>
  new AdminController(s, addons, rt as unknown as PluginRuntimeService, audit, notifications, tokens as TokenService, invites as RegistrationInvitesService, oauth as OauthService);
function thrown(fn: () => unknown): { status: number; body: unknown } {
  try { fn(); } catch (err) {
    if (err instanceof NotFoundException) return { status: 404, body: err.getResponse() };
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    return { status: e.getStatus(), body: e.getResponse() };
  }
  throw new Error('expected throw');
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => { delete process.env.NODE_ENV; });

describe('AdminController users', () => {
  it('lists, creates (201 + audit), maps an error', () => {
    expect(adminCtl(svc({ listUsers: vi.fn().mockReturnValue([{ id: 1 }]) } as Partial<AdminService>)).listUsers()).toEqual({ users: [{ id: 1 }] });
    expect(thrown(() => adminCtl(svc({ createUser: vi.fn().mockReturnValue({ error: 'Email taken', status: 409 }) } as Partial<AdminService>)).createUser(user, {}, req))).toEqual({ status: 409, body: { error: 'Email taken' } });
    const c = adminCtl(svc({ createUser: vi.fn().mockReturnValue({ user: { id: 2 }, insertedId: 2, auditDetails: {} }) } as Partial<AdminService>));
    expect(c.createUser(user, { email: 'a@b.c' }, req)).toEqual({ user: { id: 2 } });
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.user_create' }));
  });

  it('update + delete audit and map errors', () => {
    expect(adminCtl(svc({ updateUser: vi.fn().mockReturnValue({ user: { id: 2 }, previousEmail: 'a@b.c', changed: ['role'] }) } as Partial<AdminService>)).updateUser(user, '2', {}, req)).toEqual({ user: { id: 2 } });
    expect(thrown(() => adminCtl(svc({ deleteUser: vi.fn().mockReturnValue({ error: 'Cannot delete self', status: 400 }) } as Partial<AdminService>)).deleteUser(user, '1', req))).toEqual({ status: 400, body: { error: 'Cannot delete self' } });
    expect(adminCtl(svc({ deleteUser: vi.fn().mockReturnValue({ email: 'a@b.c' }) } as Partial<AdminService>)).deleteUser(user, '2', req)).toEqual({ success: true });
  });
});

describe('AdminController permissions + oidc + misc', () => {
  it('permissions: saves + audits', () => {
    const c = adminCtl(svc({ savePermissions: vi.fn().mockReturnValue({ permissions: { x: 1 }, skipped: [] }) } as Partial<AdminService>));
    expect(c.savePermissions(user, { permissions: { x: 1 } }, req)).toEqual({ success: true, permissions: { x: 1 } });
  });

  it('permissions: includes skipped when present', () => {
    const c = adminCtl(svc({ savePermissions: vi.fn().mockReturnValue({ permissions: {}, skipped: ['bad'] }) } as Partial<AdminService>));
    expect(c.savePermissions(user, { permissions: {} }, req)).toEqual({ success: true, permissions: {}, skipped: ['bad'] });
  });


  it('save-demo-baseline maps error, else returns message', () => {
    expect(thrown(() => adminCtl(svc({ saveDemoBaseline: vi.fn().mockReturnValue({ error: 'not demo', status: 400 }) } as Partial<AdminService>)).saveDemoBaseline(user, req))).toEqual({ status: 400, body: { error: 'not demo' } });
    expect(adminCtl(svc({ saveDemoBaseline: vi.fn().mockReturnValue({ message: 'saved' }) } as Partial<AdminService>)).saveDemoBaseline(user, req)).toEqual({ success: true, message: 'saved' });
  });
});

// The feature toggles and the packing-template CRUD moved to the addons and packing
// domains; their cases live in admin-feature-toggles.controller.test.ts and
// admin-packing-templates.controller.test.ts.
describe('AdminController invites', () => {
  it('invites: create 201 + audit, delete maps error', () => {
    const c = adminCtl(svc(), undefined, undefined, {}, { createInvite: vi.fn().mockReturnValue({ invite: { id: 5 }, inviteId: 5, uses: 1, expiresInDays: 7 }) });
    expect(c.createInvite(user, {}, req)).toEqual({ invite: { id: 5 } });
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.invite_create' }));
    expect(thrown(() => adminCtl(svc(), undefined, undefined, {}, { deleteInvite: vi.fn().mockReturnValue({ error: 'not found', status: 404 }) }).deleteInvite(user, '5', req))).toEqual({ status: 404, body: { error: 'not found' } });
  });


});


describe('AdminController addons + sessions + jwt + defaults', () => {
  it('addon update audits + invalidates MCP sessions only when the MCP surface changed (#1414)', async () => {
    const invalidateMcpSessions = vi.fn();
    const runtime = { deactivateForDisabledAddon: vi.fn() } as unknown as PluginRuntimeService;
    const c = adminCtl(svc({ updateAddon: vi.fn().mockReturnValue({ addon: { id: 'mcp', enabled: true }, mcpAffected: true, auditDetails: {} }), invalidateMcpSessions } as Partial<AdminService>), runtime);
    expect(await c.updateAddon(user, 'mcp', { enabled: true }, req)).toEqual({ addon: { id: 'mcp', enabled: true } });
    expect(invalidateMcpSessions).toHaveBeenCalled();
    expect(runtime.deactivateForDisabledAddon).not.toHaveBeenCalled();

    // Config-only saves / MCP-irrelevant addons keep live sessions alive.
    const noopInvalidate = vi.fn();
    const noop = adminCtl(svc({ updateAddon: vi.fn().mockReturnValue({ addon: { id: 'llm_parsing', enabled: true }, mcpAffected: false, auditDetails: {} }), invalidateMcpSessions: noopInvalidate } as Partial<AdminService>), runtime);
    expect(await noop.updateAddon(user, 'llm_parsing', { config: { model: 'x' } }, req)).toEqual({ addon: { id: 'llm_parsing', enabled: true } });
    expect(noopInvalidate).not.toHaveBeenCalled();

    // Disabling an addon cascades to the plugin runtime.
    const runtime2 = { deactivateForDisabledAddon: vi.fn().mockResolvedValue(['p1']) } as unknown as PluginRuntimeService;
    const disable = adminCtl(svc({ updateAddon: vi.fn().mockReturnValue({ addon: { id: 'budget', enabled: false }, mcpAffected: true, auditDetails: {} }), invalidateMcpSessions: vi.fn() } as Partial<AdminService>), runtime2);
    await disable.updateAddon(user, 'budget', { enabled: false }, req);
    expect(runtime2.deactivateForDisabledAddon).toHaveBeenCalledWith('budget');
  });

  it('addon update maps the journey-dependency refusal to its status, before any audit', async () => {
    const c = adminCtl(svc({ updateAddon: vi.fn().mockReturnValue({ error: 'Enable the Journey addon first', status: 409 }) } as Partial<AdminService>));
    const err = await c.updateAddon(user, 'immich', { enabled: true }, req).then(
      () => null,
      (e: unknown) => e as HttpException,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect(err!.getStatus()).toBe(409);
    expect(err!.getResponse()).toEqual({ error: 'Enable the Journey addon first' });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('oauth-sessions revoke audits; rotate-jwt maps error', () => {
    expect(adminCtl(svc(), undefined, undefined, {}, {}, { adminRevokeOAuthSession: vi.fn().mockReturnValue({}) }).revokeOAuthSession(user, '3', req)).toEqual({ success: true });
    expect(thrown(() => adminCtl(svc({ rotateJwtSecret: vi.fn().mockReturnValue({ error: 'locked', status: 409 }) } as Partial<AdminService>)).rotateJwtSecret(user, req))).toEqual({ status: 409, body: { error: 'locked' } });
    expect(adminCtl(svc({ rotateJwtSecret: vi.fn().mockReturnValue({}) } as Partial<AdminService>)).rotateJwtSecret(user, req)).toEqual({ success: true });
  });

});

describe('AdminController error envelope fallbacks', () => {
  it('ok() defaults to 400 when the error envelope omits a status', () => {
    expect(thrown(() => adminCtl(svc({ createUser: vi.fn().mockReturnValue({ error: 'boom' }) } as Partial<AdminService>)).createUser(user, {}, req))).toEqual({ status: 400, body: { error: 'boom' } });
  });


});

describe('AdminController read-only getters', () => {
  it('return service values verbatim', async () => {
    expect(adminCtl(svc({ resetUserPasskeys: vi.fn().mockReturnValue({ email: 'a@b.c', deleted: 2 }) } as Partial<AdminService>)).resetUserPasskeys(user, '4', req)).toEqual({ success: true, deleted: 2 });
    expect(adminCtl(svc({ getStats: vi.fn().mockReturnValue({ users: 3 }) } as Partial<AdminService>)).stats()).toEqual({ users: 3 });
    expect(adminCtl(svc({ getPermissions: vi.fn().mockReturnValue({ a: 1 }) } as Partial<AdminService>)).permissions()).toEqual({ a: 1 });
    expect(adminCtl(svc({ getAuditLog: vi.fn().mockReturnValue({ entries: [] }) } as Partial<AdminService>)).auditLog({})).toEqual({ entries: [] });
    await expect(adminCtl(svc({ checkVersion: vi.fn().mockResolvedValue({ current: '1' }) } as Partial<AdminService>)).versionCheck()).resolves.toEqual({ current: '1' });
    expect(adminCtl(svc(), undefined, undefined, {}, { listInvites: vi.fn().mockReturnValue([{ id: 1 }]) }).listInvites()).toEqual({ invites: [{ id: 1 }] });
    expect(adminCtl(svc({ listAddons: vi.fn().mockReturnValue([{ id: 'mcp' }]) } as Partial<AdminService>)).listAddons()).toEqual({ addons: [{ id: 'mcp' }] });
    expect(adminCtl(svc(), undefined, undefined, { listAllMcpTokens: vi.fn().mockReturnValue([{ id: 1 }]) }).listMcpTokens()).toEqual({ tokens: [{ id: 1 }] });
    expect(adminCtl(svc(), undefined, undefined, {}, {}, { listAllOAuthSessions: vi.fn().mockReturnValue([{ id: 1 }]) }).listOAuthSessions()).toEqual({ sessions: [{ id: 1 }] });
  });


  it('githubReleases falls back to default paging when no query is given', async () => {
    const getGithubReleases = vi.fn().mockResolvedValue([{ tag: 'v1' }]);
    const c = adminCtl(svc({ getGithubReleases } as Partial<AdminService>));
    await expect(c.githubReleases()).resolves.toEqual([{ tag: 'v1' }]);
    expect(getGithubReleases).toHaveBeenCalledWith('10', '1');
    await c.githubReleases('5', '2');
    expect(getGithubReleases).toHaveBeenLastCalledWith('5', '2');
  });
});



describe('AdminController tokens + sessions', () => {
  it('mcp token + oauth session deletes return success and map errors', () => {
    expect(adminCtl(svc(), undefined, undefined, { adminDeleteMcpToken: vi.fn().mockReturnValue({}) }).deleteMcpToken(user, '2', req)).toEqual({ success: true });
    expect(thrown(() => adminCtl(svc(), undefined, undefined, { adminDeleteMcpToken: vi.fn().mockReturnValue({ error: 'no token', status: 404 }) }).deleteMcpToken(user, '9', req))).toEqual({ status: 404, body: { error: 'no token' } });
    expect(thrown(() => adminCtl(svc(), undefined, undefined, {}, {}, { adminRevokeOAuthSession: vi.fn().mockReturnValue({ error: 'no session', status: 404 }) }).revokeOAuthSession(user, '9', req))).toEqual({ status: 404, body: { error: 'no session' } });
  });
});


describe('AdminController dev test-notification', () => {
  it('404 outside development', async () => {
    delete process.env.NODE_ENV;
    await expect(adminCtl(svc()).devTestNotification(user, {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sends in development', async () => {
    process.env.NODE_ENV = 'development';
    const res = await adminCtl(svc()).devTestNotification(user, { event: 'trip_reminder' });
    expect(res).toEqual({ success: true });
  });

  it('applies notification defaults when the body is empty', async () => {
    process.env.NODE_ENV = 'development';
    const res = await adminCtl(svc()).devTestNotification(user, {});
    expect(res).toEqual({ success: true });
    expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ event: 'trip_reminder', scope: 'user', targetId: user.id }));
  });

  it('maps an Error from the notification service to 400', async () => {
    process.env.NODE_ENV = 'development';
    (sendNotification as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('send failed'));
    await expect(adminCtl(svc()).devTestNotification(user, { event: 'trip_reminder' })).rejects.toMatchObject({ response: { error: 'send failed' } });
  });

  it('stringifies a non-Error notification failure to 400', async () => {
    process.env.NODE_ENV = 'development';
    (sendNotification as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce('weird');
    await expect(adminCtl(svc()).devTestNotification(user, { event: 'trip_reminder' })).rejects.toMatchObject({ response: { error: 'weird' } });
  });
});

// The feature toggles now go straight to AddonsService — these cases used to assert
// the same thing through AdminService pass-throughs that no longer exist.
describe('AdminController feature toggles', () => {
  it('ADMIN-TOGGLE-001 each toggle forwards to AddonsService and writes its own audit action', () => {
    const addons = addonsStub();
    const c = adminCtl(svc(), undefined, addons);
    const cases: Array<[() => unknown, string, keyof AddonsService]> = [
      [() => c.updateBagTracking(user, { enabled: true }, req), 'admin.bag_tracking', 'updateBagTracking'],
      [() => c.updatePlacesPhotos(user, { enabled: true }, req), 'admin.places_photos', 'updatePlacesPhotos'],
      [() => c.updatePlacesAutocomplete(user, { enabled: true }, req), 'admin.places_autocomplete', 'updatePlacesAutocomplete'],
      [() => c.updatePlacesDetails(user, { enabled: true }, req), 'admin.places_details', 'updatePlacesDetails'],
      [() => c.updatePlaceShadow(user, { enabled: true }, req), 'admin.place_shadow', 'updatePlaceShadow'],
    ];
    for (const [run, action, method] of cases) {
      writeAudit.mockClear();
      expect(run()).toEqual({ enabled: true });
      expect(addons[method]).toHaveBeenCalledWith(true);
      expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action, details: { enabled: true } }));
    }
  });

  it('ADMIN-TOGGLE-002 the getters return the AddonsService value verbatim', () => {
    const c = adminCtl(svc());
    expect(c.getBagTracking()).toEqual({ enabled: false });
    expect(c.getPlacesPhotos()).toEqual({ enabled: false });
    expect(c.getPlacesAutocomplete()).toEqual({ enabled: false });
    expect(c.getPlacesDetails()).toEqual({ enabled: false });
    expect(c.getPlaceShadow()).toEqual({ enabled: false });
    expect(c.getPlacesEnrich()).toEqual({ enabled: true });
    expect(c.getCollabFeatures()).toEqual({ chat: false });
  });

  it('ADMIN-TOGGLE-002b places-enrich updates through the addons domain and is audited', () => {
    const c = adminCtl(svc());
    expect(c.updatePlacesEnrich(user, { enabled: false }, req)).toEqual({ enabled: false });
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.places_enrich' }));
  });

  it('ADMIN-TOGGLE-004 place-shadow forwards the body value and audits the stored one', () => {
    // The handler audits result.enabled. A service that declines the flip must
    // not leave behind an audit row claiming the shadow log was switched on.
    const updatePlaceShadow = vi.fn(() => ({ enabled: false }));
    const c = adminCtl(svc(), undefined, { ...addonsStub(), updatePlaceShadow } as unknown as AddonsService);
    expect(c.updatePlaceShadow(user, { enabled: true }, req)).toEqual({ enabled: false });
    expect(updatePlaceShadow).toHaveBeenCalledWith(true);
    expect(writeAudit).toHaveBeenCalledWith({ userId: user.id, action: 'admin.place_shadow', ip: '1.2.3.4', details: { enabled: false } });
    // Off is carried too: the table above only ever asks for true, so a handler
    // that hardcoded the argument would pass it.
    c.updatePlaceShadow(user, { enabled: false }, req);
    expect(updatePlaceShadow).toHaveBeenLastCalledWith(false);
  });

  it('ADMIN-TOGGLE-004b place-shadow reads through to AddonsService instead of a controller-side default', () => {
    const getPlaceShadow = vi.fn(() => ({ enabled: true }));
    const c = adminCtl(svc(), undefined, { ...addonsStub(), getPlaceShadow } as unknown as AddonsService);
    expect(c.getPlaceShadow()).toEqual({ enabled: true });
    expect(getPlaceShadow).toHaveBeenCalledTimes(1);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('ADMIN-TOGGLE-003 collab-features invalidates MCP sessions only when a flag flipped (#1414)', () => {
    const invalidateMcpSessions = vi.fn();
    const c = adminCtl(svc({ invalidateMcpSessions } as Partial<AdminService>));
    expect(c.updateCollabFeatures(user, { chat: true }, req)).toEqual({ chat: true });
    expect(invalidateMcpSessions).toHaveBeenCalled();

    const noopInvalidate = vi.fn();
    const noop = adminCtl(
      svc({ invalidateMcpSessions: noopInvalidate } as Partial<AdminService>),
      undefined,
      { ...addonsStub(), updateCollabFeatures: vi.fn(() => ({ features: { chat: true }, changed: false })) } as unknown as AddonsService,
    );
    expect(noop.updateCollabFeatures(user, { chat: true }, req)).toEqual({ chat: true });
    expect(noopInvalidate).not.toHaveBeenCalled();
  });
});
