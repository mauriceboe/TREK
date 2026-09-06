import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { ChannelTestResult, UnreadCountResult } from '@trek/shared';
import type { User } from '../../types';
import { NotificationsService } from './notifications.service';
import { resolveNtfyToken } from './transports/ntfy.service';
import {
  PreferencesUpdateDto,
  TestSmtpDto,
  TestWebhookDto,
  TestNtfyDto,
  NotificationRespondDto,
} from './notifications.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { NotificationPreferencesService } from './notification-preferences.service';
import { AdminNotificationPreferencesDto } from '../admin/admin.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { ManagedForbidden } from '../common/managed';

// The masked placeholder the client sends instead of a stored secret (8× U+2022).
const MASKED = '••••••••';

/**
 * /api/notifications — channel-preference matrix, channel test pings, and in-app
 * notifications.
 *
 * Byte-identical to the legacy Express route (server/src/routes/notifications.ts):
 * same auth, the same inline admin gate on /test-smtp (note: it returns
 * { error: 'Admin only' }, NOT the AdminGuard's wording), the same webhook/ntfy
 * fallback resolution, the same id parsing + 400/404 bodies, and the same status
 * codes. POSTs that answer with res.json stay 200 (Nest would default to 201).
 * The static /in-app/read-all and /in-app/all routes are declared before the
 * /in-app/:id routes so they win over the param, matching the legacy order.
 * Bodies validate via notifications.dto.ts (@trek/shared schemas through the
 * global ZodValidationPipe) — malformed bodies now get the pipe's standard
 * { error: 'field: message; …' } envelope instead of the old inline checks
 * (the sanctioned ratchet behavior); valid bodies behave byte-identically.
 */
@Controller('api/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('preferences')
  getPreferences(@CurrentUser() user: User) {
    return this.notifications.getPreferences(user.id, user.role);
  }

  @Put('preferences')
  setPreferences(@CurrentUser() user: User, @Body() body: PreferencesUpdateDto) {
    this.notifications.setPreferences(user.id, body);
    return this.notifications.getPreferences(user.id, user.role);
  }

  @ManagedForbidden('the relay is the operator credential; a test send would use their reputation')
  @Post('test-smtp')
  @HttpCode(200)
  async testSmtp(@CurrentUser() user: User, @Body() body: TestSmtpDto): Promise<ChannelTestResult> {
    if (user.role !== 'admin') {
      throw new HttpException({ error: 'Admin only' }, 403);
    }
    return this.notifications.testSmtp(body.email || user.email);
  }

  @Post('test-webhook')
  @HttpCode(200)
  async testWebhook(@CurrentUser() user: User, @Body() body: TestWebhookDto): Promise<ChannelTestResult> {
    let url: string | null | undefined = body.url;
    if (!url || url === MASKED) {
      url = this.notifications.userWebhookUrl(user.id);
      if (!url && user.role === 'admin') url = this.notifications.adminWebhookUrl();
      if (!url) {
        throw new HttpException({ error: 'No webhook URL configured' }, 400);
      }
    }
    try {
      new URL(url);
    } catch {
      throw new HttpException({ error: 'Invalid URL' }, 400);
    }
    return this.notifications.testWebhook(url);
  }

  @Post('test-ntfy')
  @HttpCode(200)
  async testNtfy(@CurrentUser() user: User, @Body() body: TestNtfyDto): Promise<ChannelTestResult> {
    const { topic, server, token } = body;
    const userCfg = this.notifications.userNtfyConfig(user.id);
    const adminCfg = this.notifications.adminNtfyConfig();

    const resolvedTopic = topic || userCfg?.topic || undefined;
    const resolvedServer = server || userCfg?.server || adminCfg.server || undefined;
    // Reuse the saved token when the request sends null, empty, or the masked placeholder.
    // Not `?? adminCfg.token`: the caller picks `server`, so that handed the
    // operator's decrypted token to any host an authenticated user named
    // (GHSA-7pqc-fj3c-9346). Same rule as the live send path, and target-based
    // rather than role-based on purpose — an admin-only gate here would take a
    // working button away from every user with their own ntfy config.
    const resolvedToken = (token && token !== MASKED)
      ? token
      : resolveNtfyToken(adminCfg, userCfg, resolvedServer ?? null);

    if (!resolvedTopic) {
      throw new HttpException({ error: 'No ntfy topic configured' }, 400);
    }
    return this.notifications.testNtfy({ topic: resolvedTopic, server: resolvedServer ?? null, token: resolvedToken });
  }

  /**
   * Generic channel test, dispatched through the registry — this is how a plugin
   * channel's "Send test" button works. The three routes above stay as they are:
   * they carry bespoke masked-secret and admin-fallback resolution whose exact
   * error bodies the client depends on, and folding them in here would risk that.
   */
  @Post('test/:channelId')
  @HttpCode(200)
  async testChannel(@CurrentUser() user: User, @Param('channelId') channelId: string): Promise<ChannelTestResult> {
    return this.notifications.testChannel(user.id, channelId);
  }

  @Get('in-app')
  listInApp(
    @CurrentUser() user: User,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('unread_only') unreadOnly?: string,
  ) {
    return this.notifications.listInApp(user.id, {
      limit: Math.min(Number.parseInt(limit as string) || 20, 50),
      offset: Number.parseInt(offset as string) || 0,
      unreadOnly: unreadOnly === 'true',
    });
  }

  @Get('in-app/unread-count')
  unreadCount(@CurrentUser() user: User): UnreadCountResult {
    return { count: this.notifications.unreadCount(user.id) };
  }

  @Put('in-app/read-all')
  readAll(@CurrentUser() user: User): { success: boolean; count: number } {
    return { success: true, count: this.notifications.markAllRead(user.id) };
  }

  @Delete('in-app/all')
  deleteAll(@CurrentUser() user: User): { success: boolean; count: number } {
    return { success: true, count: this.notifications.deleteAll(user.id) };
  }

  @Put('in-app/:id/read')
  markRead(@CurrentUser() user: User, @Param('id') idParam: string): { success: boolean } {
    const id = this.parseId(idParam);
    if (!this.notifications.markRead(id, user.id)) {
      throw new HttpException({ error: 'Not found' }, 404);
    }
    return { success: true };
  }

  @Put('in-app/:id/unread')
  markUnread(@CurrentUser() user: User, @Param('id') idParam: string): { success: boolean } {
    const id = this.parseId(idParam);
    if (!this.notifications.markUnread(id, user.id)) {
      throw new HttpException({ error: 'Not found' }, 404);
    }
    return { success: true };
  }

  @Delete('in-app/:id')
  deleteOne(@CurrentUser() user: User, @Param('id') idParam: string): { success: boolean } {
    const id = this.parseId(idParam);
    if (!this.notifications.deleteOne(id, user.id)) {
      throw new HttpException({ error: 'Not found' }, 404);
    }
    return { success: true };
  }

  @Post('in-app/:id/respond')
  @HttpCode(200)
  async respond(
    @CurrentUser() user: User,
    @Param('id') idParam: string,
    @Body() body: NotificationRespondDto,
  ): Promise<{ success: boolean; notification: unknown }> {
    const id = this.parseId(idParam);
    const result = await this.notifications.respond(id, user.id, body.response);
    if (!result.success) {
      throw new HttpException({ error: result.error }, 400);
    }
    return { success: true, notification: result.notification };
  }

  /** parseInt + the legacy "Invalid id" 400 guard, shared by the /:id handlers. */
  private parseId(idParam: string): number {
    const id = Number.parseInt(idParam);
    if (Number.isNaN(id)) {
      throw new HttpException({ error: 'Invalid id' }, 400);
    }
    return id;
  }
}

/**
 * /api/admin/notification-preferences — the admin-scope row of the preference matrix.
 *
 * Two routes that sat on AdminController and reached NotificationPreferencesService
 * through a pair of pass-through methods on AdminService. The owner is here; the
 * 'admin' scope argument they always passed is now written once, at the only place
 * that uses it.
 */
@Controller('api/admin/notification-preferences')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminNotificationPreferencesController {
  constructor(private readonly prefs: NotificationPreferencesService) {}

  @Get()
  get(@CurrentUser() user: User) {
    return this.prefs.getPreferencesMatrix(user.id, user.role, 'admin');
  }

  @Put()
  set(@CurrentUser() user: User, @Body() body: AdminNotificationPreferencesDto) {
    this.prefs.setAdminPreferences(user.id, body);
    // Answer with the refreshed matrix rather than the raw write result — the admin
    // panel renders straight from this response.
    return this.prefs.getPreferencesMatrix(user.id, user.role, 'admin');
  }
}
