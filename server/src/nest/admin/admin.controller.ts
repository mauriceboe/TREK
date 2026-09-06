import { Body, Controller, Delete, Get, HttpCode, HttpException, NotFoundException, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { readEnv } from '../../app-config';
import { AdminService } from './admin.service';
import { TokenService } from '../tokens/token.service';
import { RegistrationInvitesService } from '../auth/registration-invites.service';
import { OauthService } from '../oauth/oauth.service';
import { KitineraryExtractorService } from '../booking-import/kitinerary-extractor.service';
import {
  AdminUserCreateDto,
  AdminUserUpdateDto,
  AdminPermissionsDto,
  AdminInviteCreateDto,
  AdminFeatureToggleDto,
  AdminTemplateNameDto,
  AdminOidcUpdateDto,
  AdminAddonUpdateDto,
  AdminCollabFeaturesDto,
  AdminNotificationPreferencesDto,
  AdminDefaultUserSettingsDto,
  AdminTestNotificationDto,
} from './admin.dto';
import { PluginRuntimeService } from '../plugins/plugin-runtime.service';
import { AddonsService } from '../addons/addons.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { getClientIp } from '../audit/client-ip';
import { logInfo } from '../audit/audit-log.logger';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { User } from '../../types';
import { ManagedForbidden } from '../common/managed';

/** Throw the legacy {error,status} envelope when a service call reports failure. */
function ok<T>(result: T): Exclude<T, { error: string }> {
  if (result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)) {
    const r = result as unknown as { error: string; status?: number };
    throw new HttpException({ error: r.error }, r.status ?? 400);
  }
  return result as Exclude<T, { error: string }>;
}

/**
 * /api/admin — admin-only control surface (users, stats, permissions, audit log,
 * OIDC settings, invites, feature toggles, packing templates, addons, MCP/OAuth
 * sessions, JWT rotation, default user settings).
 *
 * Byte-identical to the legacy Express route (server/src/routes/admin.ts):
 * admin-gated, the {error,status} envelopes, the audit-log writes, the MCP
 * session invalidation on addon/collab changes, create-201 vs the rest 200, and
 * the dev-only test-notification endpoint (404 outside development).
 *
 * Bodies validate via admin.dto.ts (@trek/shared schemas through the global
 * ZodValidationPipe) — malformed bodies now get the pipe's standard
 * { error: 'field: message; …' } envelope instead of the old inline typeof
 * checks (the sanctioned ratchet behavior); valid bodies behave identically,
 * and every bespoke service-level 400 is untouched.
 */
@Controller('api/admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly addons: AddonsService,
    private readonly pluginRuntime: PluginRuntimeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly tokens: TokenService,
    private readonly invites: RegistrationInvitesService,
    private readonly oauth: OauthService,
    private readonly kitinerary: KitineraryExtractorService,
  ) {}

  // ── Users ──
  @Get('users')
  listUsers() { return { users: this.admin.listUsers() }; }

  @Post('users')
  @HttpCode(201)
  createUser(@CurrentUser() user: User, @Body() body: AdminUserCreateDto, @Req() req: Request) {
    const result = ok(this.admin.createUser(body as Parameters<AdminService['createUser']>[0]));
    this.audit.writeAudit({ userId: user.id, action: 'admin.user_create', resource: String(result.insertedId), ip: getClientIp(req), details: result.auditDetails });
    return { user: result.user };
  }

  @Put('users/:id')
  updateUser(@CurrentUser() user: User, @Param('id') id: string, @Body() body: AdminUserUpdateDto, @Req() req: Request) {
    const result = ok(this.admin.updateUser(id, body));
    this.audit.writeAudit({ userId: user.id, action: 'admin.user_update', resource: String(id), ip: getClientIp(req), details: { targetUser: result.previousEmail, fields: result.changed } });
    logInfo(`Admin ${user.email} edited user ${result.previousEmail} (fields: ${result.changed.join(', ')})`);
    return { user: result.user };
  }

  @Delete('users/:id')
  deleteUser(@CurrentUser() user: User, @Param('id') id: string, @Req() req: Request) {
    const result = ok(this.admin.deleteUser(id, user.id));
    this.audit.writeAudit({ userId: user.id, action: 'admin.user_delete', resource: String(id), ip: getClientIp(req), details: { targetUser: result.email } });
    logInfo(`Admin ${user.email} deleted user ${result.email}`);
    return { success: true };
  }

  @Delete('users/:id/passkeys')
  resetUserPasskeys(@CurrentUser() user: User, @Param('id') id: string, @Req() req: Request) {
    const result = ok(this.admin.resetUserPasskeys(id));
    this.audit.writeAudit({ userId: user.id, action: 'admin.user_passkeys_reset', resource: String(id), ip: getClientIp(req), details: { targetUser: result.email, deleted: result.deleted } });
    return { success: true, deleted: result.deleted };
  }

  @Delete('users/:id/mfa')
  resetUserMfa(@CurrentUser() user: User, @Param('id') id: string, @Req() req: Request) {
    const result = ok(this.admin.resetUserMfa(id, user.id));
    this.audit.writeAudit({ userId: user.id, action: 'admin.user_mfa_reset', resource: String(id), ip: getClientIp(req), details: { targetUser: result.email } });
    return { success: true };
  }

  // ── Stats / permissions / audit ──
  @Get('stats')
  stats() { return this.admin.getStats(); }

  @Get('permissions')
  permissions() { return this.admin.getPermissions(); }

  @Put('permissions')
  savePermissions(@CurrentUser() user: User, @Body() body: AdminPermissionsDto, @Req() req: Request) {
    const result = this.admin.savePermissions(body.permissions as unknown as Parameters<AdminService['savePermissions']>[0]);
    this.audit.writeAudit({ userId: user.id, action: 'admin.permissions_update', resource: 'permissions', ip: getClientIp(req), details: body.permissions as Record<string, unknown> });
    return { success: true, permissions: result.permissions, ...(result.skipped.length ? { skipped: result.skipped } : {}) };
  }

  @Get('audit-log')
  auditLog(@Query() query: { limit?: string; offset?: string }) { return this.admin.getAuditLog(query); }

  @Post('save-demo-baseline')
  @HttpCode(200)
  saveDemoBaseline(@CurrentUser() user: User, @Req() req: Request) {
    const result = this.admin.saveDemoBaseline();
    if (result.error) {
      throw new HttpException({ error: result.error }, result.status!);
    }
    this.audit.writeAudit({ userId: user.id, action: 'admin.demo_baseline_save', ip: getClientIp(req) });
    return { success: true, message: result.message };
  }

  // ── GitHub / version ──
  @Get('github-releases')
  async githubReleases(@Query('per_page') perPage = '10', @Query('page') page = '1') {
    return this.admin.getGithubReleases(String(perPage), String(page));
  }

  @Get('version-check')
  async versionCheck() { return this.admin.checkVersion(); }

  /**
   * Versions of the bundled tools an operator cannot see from the UI. Today the
   * only one is the KItinerary extractor, whose age decides which booking
   * providers parse at all — and a stale one is indistinguishable from an
   * unsupported provider without this (#2261).
   */
  @Get('system-info')
  systemInfo() { return { kitinerary: this.kitinerary.describe() }; }

  // ── Invites ──
  @Get('invites')
  listInvites() { return { invites: this.invites.listInvites() }; }

  // Trips an admin can optionally bind a registration invite to (#1402).
  @Get('invites/trips')
  listInviteTrips() { return { trips: this.invites.listTripsForInvite() }; }

  @Post('invites')
  @HttpCode(201)
  createInvite(@CurrentUser() user: User, @Body() body: AdminInviteCreateDto, @Req() req: Request) {
    const result = this.invites.createInvite(user.id, body);
    this.audit.writeAudit({ userId: user.id, action: 'admin.invite_create', resource: String(result.inviteId), ip: getClientIp(req), details: { max_uses: result.uses, expires_in_days: result.expiresInDays, trip_id: result.tripId } });
    return { invite: result.invite };
  }

  @Delete('invites/:id')
  deleteInvite(@CurrentUser() user: User, @Param('id') id: string, @Req() req: Request) {
    ok(this.invites.deleteInvite(id));
    this.audit.writeAudit({ userId: user.id, action: 'admin.invite_delete', resource: String(id), ip: getClientIp(req) });
    return { success: true };
  }

  // ── Feature toggles ──
  // Straight to AddonsService, which owns every one of these flags. They used to go
  // through eleven-plus pass-through methods on AdminService, and the three places
  // flags were raw app_settings SQL there even though the other flags lived in the
  // addons domain. The routes stay HERE rather than moving next to the service: an
  // admin-gated controller in AddonsModule would make that module import AuthModule,
  // and PluginGuardsModule imports AddonsModule precisely because it is a leaf — the
  // edge would close a cycle.

  @Get('bag-tracking')
  getBagTracking() { return this.addons.getBagTracking(); }

  @Put('bag-tracking')
  updateBagTracking(@CurrentUser() user: User, @Body() body: AdminFeatureToggleDto, @Req() req: Request) {
    const result = this.addons.updateBagTracking(body.enabled);
    this.audit.writeAudit({ userId: user.id, action: 'admin.bag_tracking', ip: getClientIp(req), details: { enabled: result.enabled } });
    return result;
  }

  @Get('places-photos')
  getPlacesPhotos() { return this.addons.getPlacesPhotos(); }

  @Put('places-photos')
  updatePlacesPhotos(@CurrentUser() user: User, @Body() body: AdminFeatureToggleDto, @Req() req: Request) {
    const result = this.addons.updatePlacesPhotos(body.enabled);
    this.audit.writeAudit({ userId: user.id, action: 'admin.places_photos', ip: getClientIp(req), details: { enabled: result.enabled } });
    return result;
  }

  @Get('places-autocomplete')
  getPlacesAutocomplete() { return this.addons.getPlacesAutocomplete(); }

  @Put('places-autocomplete')
  updatePlacesAutocomplete(@CurrentUser() user: User, @Body() body: AdminFeatureToggleDto, @Req() req: Request) {
    const result = this.addons.updatePlacesAutocomplete(body.enabled);
    this.audit.writeAudit({ userId: user.id, action: 'admin.places_autocomplete', ip: getClientIp(req), details: { enabled: result.enabled } });
    return result;
  }

  @Get('places-details')
  getPlacesDetails() { return this.addons.getPlacesDetails(); }

  @Put('places-details')
  updatePlacesDetails(@CurrentUser() user: User, @Body() body: AdminFeatureToggleDto, @Req() req: Request) {
    const result = this.addons.updatePlacesDetails(body.enabled);
    this.audit.writeAudit({ userId: user.id, action: 'admin.places_details', ip: getClientIp(req), details: { enabled: result.enabled } });
    return result;
  }

  @Get('place-shadow')
  getPlaceShadow() { return this.addons.getPlaceShadow(); }

  @Put('place-shadow')
  updatePlaceShadow(@CurrentUser() user: User, @Body() body: AdminFeatureToggleDto, @Req() req: Request) {
    const result = this.addons.updatePlaceShadow(body.enabled);
    this.audit.writeAudit({ userId: user.id, action: 'admin.place_shadow', ip: getClientIp(req), details: { enabled: result.enabled } });
    return result;
  }

  @Get('places-enrich')
  getPlacesEnrich() { return this.addons.getPlacesEnrich(); }

  @Put('places-enrich')
  updatePlacesEnrich(@CurrentUser() user: User, @Body() body: AdminFeatureToggleDto, @Req() req: Request) {
    const result = this.addons.updatePlacesEnrich(body.enabled);
    this.audit.writeAudit({ userId: user.id, action: 'admin.places_enrich', ip: getClientIp(req), details: { enabled: result.enabled } });
    return result;
  }

  @Get('collab-features')
  getCollabFeatures() { return this.addons.getCollabFeatures(); }

  @Put('collab-features')
  updateCollabFeatures(@CurrentUser() user: User, @Body() body: AdminCollabFeaturesDto, @Req() req: Request) {
    const { features, changed } = this.addons.updateCollabFeatures(body);
    // Collab flags gate MCP registration, but a no-op save must not tear down
    // every live MCP session (#1414).
    if (changed) this.admin.invalidateMcpSessions();
    this.audit.writeAudit({ userId: user.id, action: 'admin.collab_features', ip: getClientIp(req), details: features });
    return features;
  }

  // ── Addons ──
  @Get('addons')
  listAddons() { return { addons: this.admin.listAddons() }; }

  @Put('addons/:id')
  async updateAddon(@CurrentUser() user: User, @Param('id') id: string, @Body() body: AdminAddonUpdateDto, @Req() req: Request) {
    const result = ok(this.admin.updateAddon(id, body));
    this.audit.writeAudit({ userId: user.id, action: 'admin.addon_update', resource: String(id), ip: getClientIp(req), details: result.auditDetails });
    // Sessions only need re-creating when the registered MCP surface can
    // actually change — an enabled-flip of an MCP-relevant addon. Config-only
    // saves and photo-provider toggles used to kill every session (#1414).
    if (result.mcpAffected) this.admin.invalidateMcpSessions();
    // Disabling an addon cascades to plugins that require it: stop them (and any
    // plugin that transitively depends on them) so a plugin never runs against a
    // disabled addon (#plugins dependencies).
    if (result.addon && result.addon.enabled === false && (body as { enabled?: boolean })?.enabled === false) {
      const stopped = await this.pluginRuntime.deactivateForDisabledAddon(id);
      // A stopped plugin takes its MCP tools off the surface, and the addon that
      // cascaded here is not necessarily an MCP-relevant one, so mcpAffected
      // above does not cover this. Still conditional on something actually
      // stopping, which keeps the #1414 rule that a no-op save kills nothing.
      if (stopped.length && !result.mcpAffected) this.admin.invalidateMcpSessions();
    }
    return { addon: result.addon };
  }

  // ── MCP tokens / OAuth sessions ──
  @Get('mcp-tokens')
  listMcpTokens() { return { tokens: this.tokens.listAllMcpTokens() }; }

  @Delete('mcp-tokens/:id')
  deleteMcpToken(@CurrentUser() user: User, @Param('id') id: string, @Req() req: Request) {
    ok(this.tokens.adminDeleteMcpToken(id));
    this.audit.writeAudit({ userId: user.id, action: 'admin.mcp_token_delete', resource: String(id), ip: getClientIp(req) });
    return { success: true };
  }

  @Get('oauth-sessions')
  listOAuthSessions() { return { sessions: this.oauth.listAllOAuthSessions() }; }

  @Delete('oauth-sessions/:id')
  revokeOAuthSession(@CurrentUser() user: User, @Param('id') id: string, @Req() req: Request) {
    ok(this.oauth.adminRevokeOAuthSession(id));
    this.audit.writeAudit({ userId: user.id, action: 'admin.oauth_session_revoke', resource: String(id), ip: getClientIp(req) });
    return { success: true };
  }

  // ── JWT rotation ──
  @ManagedForbidden('rotating the secret signs every user out and fixes nothing the admin can reach')
  @Post('rotate-jwt-secret')
  @HttpCode(200)
  rotateJwtSecret(@CurrentUser() user: User, @Req() req: Request) {
    const result = this.admin.rotateJwtSecret();
    if (result.error) {
      throw new HttpException({ error: result.error }, result.status!);
    }
    this.audit.writeAudit({ userId: user.id, action: 'admin.rotate_jwt_secret', ip: getClientIp(req) });
    return { success: true };
  }

  // ── Default user settings ──
  // ── Dev-only: test notification (404 outside development, mirroring the conditional mount) ──
  @Post('dev/test-notification')
  @HttpCode(200)
  async devTestNotification(@CurrentUser() user: User, @Body() body: AdminTestNotificationDto) {
    if (!readEnv().app.isDevelopment) {
      throw new NotFoundException();
    }
    try {
      await this.notifications.send({
        event: body.event ?? 'trip_reminder',
        actorId: user.id,
        scope: body.scope ?? 'user',
        targetId: body.targetId ?? user.id,
        params: { actor: user.email, ...(body.params ?? {}) },
        inApp: body.inApp,
      } as unknown as Parameters<NotificationsService['send']>[0]);
      return { success: true };
    } catch (err) {
      throw new HttpException({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  }
}
