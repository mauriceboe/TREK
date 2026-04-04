import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { User, Check, X, ArrowRight, Trash2, CheckCheck } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useInAppNotificationStore, InAppNotification } from '../../store/inAppNotificationStore'
import { useSettingsStore } from '../../store/settingsStore'

function relativeTime(dateStr: string, locale: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return locale === 'ar' ? 'الآن' : 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

interface NotificationItemProps {
  notification: InAppNotification
  onClose?: () => void
}

export default function InAppNotificationItem({ notification, onClose }: NotificationItemProps): React.ReactElement {
  const { t, locale } = useTranslation()
  const navigate = useNavigate()
  const { settings } = useSettingsStore()
  const darkMode = settings.dark_mode
  const dark = darkMode === true || darkMode === 'dark' || (darkMode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [responding, setResponding] = useState(false)

  const { markRead, markUnread, deleteNotification, respondToBoolean } = useInAppNotificationStore()

  const handleNavigate = async () => {
    if (!notification.is_read) await markRead(notification.id)
    if (notification.navigate_target) {
      navigate(notification.navigate_target)
      onClose?.()
    }
  }

  const handleRespond = async (response: 'positive' | 'negative') => {
    if (responding || notification.response !== null) return
    setResponding(true)
    await respondToBoolean(notification.id, response)
    setResponding(false)
  }

  const titleText = t(notification.title_key, notification.title_params)
  const bodyText = t(notification.text_key, notification.text_params)
  const hasUnknownTitle = titleText === notification.title_key
  const hasUnknownBody = bodyText === notification.text_key

  return (
    <div
      className="relative px-4 py-3 transition-colors"
      style={{
        background: notification.is_read ? 'transparent' : (dark ? 'rgba(99,102,241,0.07)' : 'rgba(99,102,241,0.05)'),
        borderBottom: '1px solid var(--border-secondary)',
      }}
    >
      {/* Unread dot */}
      {!notification.is_read && (
        <div className="absolute left-2 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full" style={{ background: '#6366f1' }} />
      )}

      <div className="flex gap-3 items-start">
        {/* Sender avatar */}
        <div className="flex-shrink-0 mt-0.5">
          {notification.sender_avatar ? (
            <img
              src={notification.sender_avatar}
              alt=""
              className="w-8 h-8 rounded-full object-cover"
            />
          ) : (
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
              style={{ background: dark ? '#27272a' : '#f1f5f9', color: 'var(--text-muted)' }}
            >
              {notification.sender_username
                ? notification.sender_username.charAt(0).toUpperCase()
                : <User className="w-4 h-4" />
              }
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium leading-snug" style={{ color: 'var(--text-primary)' }}>
              {hasUnknownTitle ? notification.title_key : titleText}
            </p>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <span className="text-xs mr-1" style={{ color: 'var(--text-faint)' }}>
                {relativeTime(notification.created_at, locale)}
              </span>
              {!notification.is_read && (
                <button
                  onClick={() => markRead(notification.id)}
                  title={t('notifications.markRead')}
                  className="p-1 rounded transition-colors"
                  style={{ color: 'var(--text-faint)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = '#6366f1' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-faint)' }}
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => deleteNotification(notification.id)}
                title={t('notifications.delete')}
                className="p-1 rounded transition-colors"
                style={{ color: 'var(--text-faint)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.1)'; e.currentTarget.style.color = '#ef4444' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-faint)' }}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {hasUnknownBody ? notification.text_key : bodyText}
          </p>

          {/* Boolean actions */}
          {notification.type === 'boolean' && notification.positive_text_key && notification.negative_text_key && (
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => handleRespond('positive')}
                disabled={responding || notification.response !== null}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
                style={{
                  background: notification.response === 'positive'
                    ? '#6366f1'
                    : notification.response === 'negative'
                      ? (dark ? '#27272a' : '#f1f5f9')
                      : (dark ? '#27272a' : '#f1f5f9'),
                  color: notification.response === 'positive'
                    ? '#fff'
                    : notification.response === 'negative'
                      ? 'var(--text-faint)'
                      : 'var(--text-secondary)',
                  opacity: notification.response === 'negative' ? 0.5 : 1,
                  cursor: notification.response !== null || responding ? 'default' : 'pointer',
                }}
              >
                <Check className="w-3 h-3" />
                {t(notification.positive_text_key)}
              </button>
              <button
                onClick={() => handleRespond('negative')}
                disabled={responding || notification.response !== null}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
                style={{
                  background: notification.response === 'negative'
                    ? '#ef4444'
                    : notification.response === 'positive'
                      ? (dark ? '#27272a' : '#f1f5f9')
                      : (dark ? '#27272a' : '#f1f5f9'),
                  color: notification.response === 'negative'
                    ? '#fff'
                    : notification.response === 'positive'
                      ? 'var(--text-faint)'
                      : 'var(--text-secondary)',
                  opacity: notification.response === 'positive' ? 0.5 : 1,
                  cursor: notification.response !== null || responding ? 'default' : 'pointer',
                }}
              >
                <X className="w-3 h-3" />
                {t(notification.negative_text_key)}
              </button>
            </div>
          )}

          {/* Navigate action */}
          {notification.type === 'navigate' && notification.navigate_text_key && notification.navigate_target && (
            <button
              onClick={handleNavigate}
              className="flex items-center gap-1 mt-2 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
              style={{ background: dark ? '#27272a' : '#f1f5f9', color: 'var(--text-secondary)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = dark ? '#27272a' : '#f1f5f9'}
            >
              <ArrowRight className="w-3 h-3" />
              {t(notification.navigate_text_key)}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
