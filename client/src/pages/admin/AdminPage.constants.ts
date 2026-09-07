/** Static label-key maps for the admin notification matrix. No React, no side effects. */

export const ADMIN_EVENT_LABEL_KEYS: Record<string, string> = {
  version_available: 'settings.notifyVersionAvailable',
  replica_failure: 'settings.notifyReplicaFailure',
}

export const ADMIN_CHANNEL_LABEL_KEYS: Record<string, string> = {
  inapp: 'settings.notificationPreferences.inapp',
  email: 'settings.notificationPreferences.email',
  webhook: 'settings.notificationPreferences.webhook',
  ntfy: 'settings.notificationPreferences.ntfy',
}
