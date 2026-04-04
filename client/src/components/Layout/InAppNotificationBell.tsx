import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Bell, Trash2, CheckCheck } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useInAppNotificationStore } from '../../store/inAppNotificationStore.ts'
import { useSettingsStore } from '../../store/settingsStore'
import { useAuthStore } from '../../store/authStore'
import InAppNotificationItem from '../Notifications/InAppNotificationItem.tsx'

export default function InAppNotificationBell(): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { settings } = useSettingsStore()
  const darkMode = settings.dark_mode
  const dark = darkMode === true || darkMode === 'dark' || (darkMode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  const { notifications, unreadCount, isLoading, fetchNotifications, fetchUnreadCount, markAllRead, deleteAll } = useInAppNotificationStore()

  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (isAuthenticated) {
      fetchUnreadCount()
    }
  }, [isAuthenticated])

  const handleOpen = () => {
    if (!open) {
      fetchNotifications(true)
    }
    setOpen(v => !v)
  }

  const handleShowAll = () => {
    setOpen(false)
    navigate('/notifications')
  }

  const displayCount = unreadCount > 99 ? '99+' : unreadCount

  return (
    <div className="relative flex-shrink-0">
      <button
        onClick={handleOpen}
        title={t('notifications.title')}
        className="relative p-2 rounded-lg transition-colors"
        style={{ color: 'var(--text-muted)' }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex items-center justify-center rounded-full text-white font-bold"
            style={{
              background: '#ef4444',
              fontSize: 9,
              minWidth: 14,
              height: 14,
              padding: '0 3px',
              lineHeight: 1,
            }}
          >
            {displayCount}
          </span>
        )}
      </button>

      {open && ReactDOM.createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setOpen(false)} />
          <div
            className="rounded-xl shadow-xl border overflow-hidden"
            style={{
              position: 'fixed',
              top: 'var(--nav-h)',
              right: 8,
              width: 360,
              maxWidth: 'calc(100vw - 16px)',
              maxHeight: 'min(480px, calc(100vh - var(--nav-h) - 16px))',
              zIndex: 9999,
              background: 'var(--bg-card)',
              borderColor: 'var(--border-primary)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-4 py-3 flex-shrink-0"
              style={{ borderBottom: '1px solid var(--border-secondary)' }}
            >
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('notifications.title')}
                {unreadCount > 0 && (
                  <span className="ml-2 px-1.5 py-0.5 rounded-full text-xs font-medium"
                    style={{ background: '#6366f1', color: '#fff' }}>
                    {unreadCount}
                  </span>
                )}
              </span>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    title={t('notifications.markAllRead')}
                    className="p-1.5 rounded-lg transition-colors"
                    style={{ color: 'var(--text-muted)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <CheckCheck className="w-3.5 h-3.5" />
                  </button>
                )}
                {notifications.length > 0 && (
                  <button
                    onClick={deleteAll}
                    title={t('notifications.deleteAll')}
                    className="p-1.5 rounded-lg transition-colors"
                    style={{ color: 'var(--text-muted)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Notification list */}
            <div className="overflow-y-auto flex-1">
              {isLoading && notifications.length === 0 ? (
                <div className="flex items-center justify-center py-10">
                  <div className="w-5 h-5 border-2 border-slate-200 border-t-indigo-500 rounded-full animate-spin" />
                </div>
              ) : notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 px-4 text-center gap-2">
                  <Bell className="w-8 h-8" style={{ color: 'var(--text-faint)' }} />
                  <p className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>{t('notifications.empty')}</p>
                  <p className="text-xs" style={{ color: 'var(--text-faint)' }}>{t('notifications.emptyDescription')}</p>
                </div>
              ) : (
                notifications.slice(0, 10).map(n => (
                  <InAppNotificationItem key={n.id} notification={n} onClose={() => setOpen(false)} />
                ))
              )}
            </div>

            {/* Footer */}
            <button
              onClick={handleShowAll}
              className="w-full py-2.5 text-xs font-medium transition-colors flex-shrink-0"
              style={{
                borderTop: '1px solid var(--border-secondary)',
                color: '#6366f1',
                background: 'transparent',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              {t('notifications.showAll')}
            </button>
          </div>
        </>,
        document.body
      )}
    </div>
  )
}
