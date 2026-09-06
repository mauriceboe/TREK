import { registerChannel } from '../channel-registry';
import type { ChannelMessage, ExternalChannel } from '../notification-events';
import type { MailerService } from '../mailer/mailer.service';
import { resolveAdminNtfyUrl, resolveNtfyToken, resolveNtfyUrl, type NtfyService } from '../transports/ntfy.service';
import type { WebhookService } from '../transports/webhook.service';

// The three built-in external channels, wrapping the transports that were free
// functions in services/notifications.ts before the fold. No delivery logic is
// rewritten here - it is only relocated behind the ExternalChannel interface so
// NotificationsService.send() can iterate instead of branching.

function supportsAllButSynology(event: string): boolean {
  return event !== 'synology_session_cleared';
}

export interface BuiltinChannelDeps {
  mailer: MailerService;
  webhook: WebhookService;
  ntfy: NtfyService;
}

/**
 * Build the three built-in channels over the given transports.
 *
 * They take their dependencies as an argument rather than importing them,
 * because the registry they land in is a module singleton while the transports
 * are providers. Every NotificationsService instance - the container singleton
 * and any separately-constructed one - registers from its
 * constructor, so the registry is populated on every path that can dispatch.
 * It used to happen through a side-effect import in the preferences service,
 * which meant the built-ins existed only because somebody happened to import
 * preferences; dropping that import would have silenced email, webhook and ntfy
 * without a single error.
 */
export function buildBuiltinChannels({ mailer, webhook, ntfy }: BuiltinChannelDeps): ExternalChannel[] {
  const emailChannel: ExternalChannel = {
    id: 'email',
    source: 'builtin',
    labelKey: 'settings.notificationPreferences.email',
    // Admin-scoped events (version_available) reach admins by email even when the
    // admin has not put `email` in notification_channels — the admin global pref
    // gates it instead. Verbatim from the pre-registry dispatch.
    bypassesActiveToggleForAdminEvents: true,
    supportsEvent: supportsAllButSynology,
    isInstanceConfigured: () => mailer.isSmtpConfigured(),
    isConfiguredFor: (userId) => !!mailer.getUserEmail(userId),
    async sendToUser(userId, msg) {
      const email = mailer.getUserEmail(userId);
      if (!email) return false;
      return mailer.sendEmail(email, msg.title, msg.body, userId, msg.navigateTarget);
    },
    async test(userId) {
      const email = mailer.getUserEmail(userId);
      if (!email) return { success: false, error: 'No email address on file' };
      return mailer.testSmtp(email);
    },
  };

  const webhookChannel: ExternalChannel = {
    id: 'webhook',
    source: 'builtin',
    labelKey: 'settings.notificationPreferences.webhook',
    supportsAdminGlobal: true,
    supportsEvent: supportsAllButSynology,
    isConfiguredFor: (userId) => !!webhook.getUserWebhookUrl(userId),
    async sendToUser(userId, msg) {
      const url = webhook.getUserWebhookUrl(userId);
      if (!url) return false;
      return webhook.sendWebhook(url, { event: msg.event, title: msg.title, body: msg.body, tripName: msg.tripName, link: msg.url });
    },
    async sendGlobal(msg: ChannelMessage) {
      const url = webhook.getAdminWebhookUrl();
      if (!url) return false;
      return webhook.sendWebhook(url, { event: msg.event, title: msg.title, body: msg.body, link: msg.url });
    },
    async test(userId, override) {
      const url = (typeof override?.url === 'string' && override.url) || webhook.getUserWebhookUrl(userId);
      if (!url) return { success: false, error: 'No webhook URL configured' };
      return webhook.testWebhook(url);
    },
  };

  const ntfyChannel: ExternalChannel = {
    id: 'ntfy',
    source: 'builtin',
    labelKey: 'settings.notificationPreferences.ntfy',
    supportsAdminGlobal: true,
    supportsEvent: supportsAllButSynology,
    isConfiguredFor: (userId) => !!resolveNtfyUrl(ntfy.getAdminNtfyConfig(), ntfy.getUserNtfyConfig(userId)),
    async sendToUser(userId, msg) {
      const userCfg = ntfy.getUserNtfyConfig(userId);
      const adminCfg = ntfy.getAdminNtfyConfig();
      const url = resolveNtfyUrl(adminCfg, userCfg);
      if (!url) return false;
      // Not `?? adminCfg.token`: the user picks their own ntfy_server, so that
      // handed the operator's decrypted token to whatever host they named, on
      // every ordinary send and with no test route involved (GHSA-7pqc-fj3c-9346).
      return ntfy.sendNtfy(url, resolveNtfyToken(adminCfg, userCfg), { event: msg.event, title: msg.title, body: msg.body, link: msg.url });
    },
    async sendGlobal(msg: ChannelMessage) {
      const adminCfg = ntfy.getAdminNtfyConfig();
      const url = resolveAdminNtfyUrl(adminCfg);
      if (!url) return false;
      return ntfy.sendNtfy(url, adminCfg.token, { event: msg.event, title: msg.title, body: msg.body, link: msg.url });
    },
    async test(userId, override) {
      const topic = typeof override?.topic === 'string' ? override.topic : ntfy.getUserNtfyConfig(userId)?.topic;
      if (!topic) return { success: false, error: 'Could not resolve ntfy URL — missing topic' };
      return ntfy.testNtfy({
        topic,
        server: typeof override?.server === 'string' ? override.server : null,
        token: typeof override?.token === 'string' ? override.token : null,
      });
    },
  };

  return [emailChannel, webhookChannel, ntfyChannel];
}

/** Idempotent - safe to call from every entry point that needs the registry populated. */
export function registerBuiltinChannels(deps: BuiltinChannelDeps): void {
  for (const channel of buildBuiltinChannels(deps)) registerChannel(channel);
}
