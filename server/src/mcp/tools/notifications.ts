import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { isDemoUser } from '../../services/authService';
import {
  getNotifications, getUnreadCount,
  markRead as markNotificationRead, markUnread as markNotificationUnread,
  markAllRead, deleteNotification, deleteAll as deleteAllNotifications,
  respondToBoolean,
} from '../../services/inAppNotifications';
import {
  TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_WRITE,
  TOOL_ANNOTATIONS_DELETE, TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  demoDenied, ok,
} from './_shared';

export function registerNotificationTools(server: McpServer, userId: number): void {
  // --- NOTIFICATIONS ---

  server.registerTool(
    'list_notifications',
    {
      description: 'List in-app notifications for the current user.',
      inputSchema: {
        limit: z.number().int().positive().optional().default(20),
        offset: z.number().int().min(0).optional().default(0),
        unread_only: z.boolean().optional().default(false),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ limit, offset, unread_only }) => {
      const result = getNotifications(userId, { limit: limit ?? 20, offset: offset ?? 0, unreadOnly: unread_only ?? false });
      return ok(result);
    }
  );

  server.registerTool(
    'get_unread_notification_count',
    {
      description: 'Get the number of unread in-app notifications.',
      inputSchema: {},
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async () => {
      const count = getUnreadCount(userId);
      return ok({ count });
    }
  );

  server.registerTool(
    'mark_notification_read',
    {
      description: 'Mark a single notification as read.',
      inputSchema: {
        notificationId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ notificationId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const success = markNotificationRead(notificationId, userId);
      if (!success) return { content: [{ type: 'text' as const, text: 'Notification not found.' }], isError: true };
      return ok({ success: true });
    }
  );

  server.registerTool(
    'mark_notification_unread',
    {
      description: 'Mark a single notification as unread.',
      inputSchema: {
        notificationId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ notificationId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const success = markNotificationUnread(notificationId, userId);
      if (!success) return { content: [{ type: 'text' as const, text: 'Notification not found.' }], isError: true };
      return ok({ success: true });
    }
  );

  server.registerTool(
    'mark_all_notifications_read',
    {
      description: "Mark all of the current user's notifications as read.",
      inputSchema: {},
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async () => {
      if (isDemoUser(userId)) return demoDenied();
      const count = markAllRead(userId);
      return ok({ success: true, count });
    }
  );

  server.registerTool(
    'delete_notification',
    {
      description: 'Delete a single in-app notification.',
      inputSchema: {
        notificationId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ notificationId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const success = deleteNotification(notificationId, userId);
      if (!success) return { content: [{ type: 'text' as const, text: 'Notification not found.' }], isError: true };
      return ok({ success: true });
    }
  );

  server.registerTool(
    'delete_all_notifications',
    {
      description: "Delete all in-app notifications for the current user.",
      inputSchema: {},
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async () => {
      if (isDemoUser(userId)) return demoDenied();
      const count = deleteAllNotifications(userId);
      return ok({ success: true, count });
    }
  );

  server.registerTool(
    'respond_to_notification',
    {
      description: 'Respond to a boolean (yes/no) notification such as a trip invite or poll.',
      inputSchema: {
        notificationId: z.number().int().positive(),
        response: z.enum(['positive', 'negative']),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ notificationId, response }) => {
      if (isDemoUser(userId)) return demoDenied();
      const result = await respondToBoolean(notificationId, userId, response);
      if (!result.success) return { content: [{ type: 'text' as const, text: result.error ?? 'Failed to respond.' }], isError: true };
      return ok({ notification: result.notification });
    }
  );
}
