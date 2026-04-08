import { create } from 'zustand'
import { stubbedNotificationsApi as inAppNotificationsApi } from '../api/convexApiStub'

export interface InAppNotification {
  id: number
  type: 'simple' | 'boolean' | 'navigate'
  scope: 'trip' | 'user' | 'admin'
  target: number
  sender_id: number | null
  sender_username: string | null
  sender_avatar: string | null
  recipient_id: number
  title_key: string
  title_params: Record<string, string>
  text_key: string
  text_params: Record<string, string>
  positive_text_key: string | null
  negative_text_key: string | null
  response: 'positive' | 'negative' | null
  navigate_text_key: string | null
  navigate_target: string | null
  is_read: boolean
  created_at: string
}

interface RawNotification extends Omit<InAppNotification, 'title_params' | 'text_params' | 'is_read'> {
  title_params: string | Record<string, string>
  text_params: string | Record<string, string>
  is_read: number | boolean
}

function normalizeNotification(raw: RawNotification): InAppNotification {
  return {
    ...raw,
    title_params: typeof raw.title_params === 'string' ? JSON.parse(raw.title_params || '{}') : raw.title_params,
    text_params: typeof raw.text_params === 'string' ? JSON.parse(raw.text_params || '{}') : raw.text_params,
    is_read: Boolean(raw.is_read),
  }
}

interface NotificationState {
  notifications: InAppNotification[]
  unreadCount: number
  total: number
  isLoading: boolean
  hasMore: boolean

  fetchNotifications: (reset?: boolean) => Promise<void>
  fetchUnreadCount: () => Promise<void>
  markRead: (id: number) => Promise<void>
  markUnread: (id: number) => Promise<void>
  markAllRead: () => Promise<void>
  deleteNotification: (id: number) => Promise<void>
  deleteAll: () => Promise<void>
  respondToBoolean: (id: number, response: 'positive' | 'negative') => Promise<void>

  handleNewNotification: (notification: RawNotification) => void
  handleUpdatedNotification: (notification: RawNotification) => void
}

const PAGE_SIZE = 20

export const useInAppNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  total: 0,
  isLoading: false,
  hasMore: false,

  fetchNotifications: async (reset = false) => {
    const { notifications, isLoading } = get()
    if (isLoading) return

    set({ isLoading: true })
    try {
      const offset = reset ? 0 : notifications.length
      const data = await inAppNotificationsApi.list({ limit: PAGE_SIZE, offset })
      const normalized = (data.notifications as RawNotification[]).map(normalizeNotification)

      set({
        notifications: reset ? normalized : [...notifications, ...normalized],
        total: data.total,
        unreadCount: data.unread_count,
        hasMore: (reset ? normalized.length : notifications.length + normalized.length) < data.total,
        isLoading: false,
      })
    } catch {
      set({ isLoading: false })
    }
  },

  fetchUnreadCount: async () => {
    try {
      const data = await inAppNotificationsApi.unreadCount()
      set({ unreadCount: data.count })
    } catch {
      // best-effort
    }
  },

  markRead: async (id: number) => {
    try {
      await inAppNotificationsApi.markRead(id)
      set(state => ({
        notifications: state.notifications.map(n => n.id === id ? { ...n, is_read: true } : n),
        unreadCount: Math.max(0, state.unreadCount - (state.notifications.find(n => n.id === id)?.is_read ? 0 : 1)),
      }))
    } catch {
      // best-effort
    }
  },

  markUnread: async (id: number) => {
    try {
      await inAppNotificationsApi.markUnread(id)
      set(state => ({
        notifications: state.notifications.map(n => n.id === id ? { ...n, is_read: false } : n),
        unreadCount: state.unreadCount + (state.notifications.find(n => n.id === id)?.is_read ? 1 : 0),
      }))
    } catch {
      // best-effort
    }
  },

  markAllRead: async () => {
    try {
      await inAppNotificationsApi.markAllRead()
      set(state => ({
        notifications: state.notifications.map(n => ({ ...n, is_read: true })),
        unreadCount: 0,
      }))
    } catch {
      // best-effort
    }
  },

  deleteNotification: async (id: number) => {
    const notification = get().notifications.find(n => n.id === id)
    try {
      await inAppNotificationsApi.delete(id)
      set(state => ({
        notifications: state.notifications.filter(n => n.id !== id),
        total: Math.max(0, state.total - 1),
        unreadCount: notification && !notification.is_read ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
      }))
    } catch {
      // best-effort
    }
  },

  deleteAll: async () => {
    try {
      await inAppNotificationsApi.deleteAll()
      set({ notifications: [], total: 0, unreadCount: 0, hasMore: false })
    } catch {
      // best-effort
    }
  },

  respondToBoolean: async (id: number, response: 'positive' | 'negative') => {
    try {
      const data = await inAppNotificationsApi.respond(id, response)
      if (data.notification) {
        const normalized = normalizeNotification(data.notification as RawNotification)
        set(state => ({
          notifications: state.notifications.map(n => n.id === id ? normalized : n),
          unreadCount: !state.notifications.find(n => n.id === id)?.is_read
            ? Math.max(0, state.unreadCount - 1)
            : state.unreadCount,
        }))
      }
    } catch {
      // best-effort
    }
  },

  handleNewNotification: (raw: RawNotification) => {
    const notification = normalizeNotification(raw)
    set(state => ({
      notifications: [notification, ...state.notifications],
      total: state.total + 1,
      unreadCount: state.unreadCount + 1,
    }))
  },

  handleUpdatedNotification: (raw: RawNotification) => {
    const notification = normalizeNotification(raw)
    set(state => ({
      notifications: state.notifications.map(n => n.id === notification.id ? notification : n),
    }))
  },
}))
