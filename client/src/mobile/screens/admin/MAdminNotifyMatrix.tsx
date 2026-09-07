import { useEffect, useState } from 'react'
import { adminApi } from '../../../api/client'
import type { TranslationFn } from '../../../types'
import type { useToast } from '../../../components/shared/Toast'
import { ADMIN_EVENT_LABEL_KEYS, ADMIN_CHANNEL_LABEL_KEYS } from '../../../pages/admin/AdminPage.constants'
import MToggle from '../../components/MToggle'
import { MAdminCard, MAdminCardHead } from './MAdminUi'

interface ChannelInfo {
  id: string
  active: boolean
}

interface MatrixData {
  event_types: string[]
  channels?: ChannelInfo[]
  implemented_combos: Record<string, string[]>
  preferences: Record<string, Record<string, boolean>>
}

const BUILTIN_CHANNELS = ['inapp', 'email', 'webhook', 'ntfy'] as const

// Per-event × per-channel admin notification matrix — the mobile layout of
// AdminNotificationsPanel. Loads its own data and auto-saves each toggle.
export default function MAdminNotifyMatrix({ t, toast }: { t: TranslationFn; toast: ReturnType<typeof useToast> }) {
  const [matrix, setMatrix] = useState<MatrixData | null>(null)

  useEffect(() => {
    adminApi.getNotificationPreferences().then((data: MatrixData) => setMatrix(data)).catch(() => {})
  }, [])

  if (!matrix) {
    return (
      <MAdminCard>
        <p className="font-geist text-[0.6875rem] text-m-faint">{t('common.loading')}</p>
      </MAdminCard>
    )
  }

  if (matrix.event_types.length === 0) {
    return (
      <MAdminCard>
        <p className="font-geist text-[0.6875rem] text-m-faint">{t('settings.notificationPreferences.noChannels')}</p>
      </MAdminCard>
    )
  }

  // Admin-scoped events only go out over the built-in channels (plugin
  // channels are user-scoped), same rule as the desktop panel.
  const isActive = (id: string) => matrix.channels?.some((c) => c.id === id && c.active) ?? false
  const visibleChannels = BUILTIN_CHANNELS.filter(
    (ch) => isActive(ch) && matrix.event_types.some((evt) => matrix.implemented_combos[evt]?.includes(ch)),
  )

  const toggle = async (eventType: string, channel: string) => {
    const current = matrix.preferences[eventType]?.[channel] ?? true
    const updated = {
      ...matrix.preferences,
      [eventType]: { ...matrix.preferences[eventType], [channel]: !current },
    }
    setMatrix((m) => (m ? { ...m, preferences: updated } : m))
    try {
      await adminApi.updateNotificationPreferences(updated)
    } catch {
      setMatrix((m) => (m ? { ...m, preferences: matrix.preferences } : m))
      toast.error(t('common.error'))
    }
  }

  return (
    <MAdminCard>
      <MAdminCardHead title={t('admin.tabs.notifications')} hint={t('admin.notifications.adminNotificationsHint')} />
      <div className="flex items-center gap-1 border-b border-[color:var(--m-rowbr)] pb-2">
        <span className="min-w-0 flex-1" />
        {visibleChannels.map((ch) => (
          <span
            key={ch}
            className="w-[44px] flex-none text-center font-geist text-[0.5625rem] font-bold uppercase tracking-[0.04em] text-m-faint"
          >
            {t(ADMIN_CHANNEL_LABEL_KEYS[ch])}
          </span>
        ))}
      </div>
      {matrix.event_types.map((eventType) => {
        const implemented = matrix.implemented_combos[eventType] ?? []
        // Known admin events use translated labels; anything else keeps its raw id.
        const labelKey = ADMIN_EVENT_LABEL_KEYS[eventType]
        return (
          <div key={eventType} className="flex items-center gap-1 border-b border-[color:var(--m-rowbr)] py-2">
            <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-m-ink">
              {labelKey ? t(labelKey) : eventType}
            </span>
            {visibleChannels.map((ch) => (
              <span key={ch} className="flex w-[44px] flex-none justify-center">
                {implemented.includes(ch) ? (
                  <MToggle
                    checked={matrix.preferences[eventType]?.[ch] ?? true}
                    ariaLabel={`${eventType} ${ch}`}
                    onChange={() => toggle(eventType, ch)}
                  />
                ) : (
                  <span className="font-geist text-[0.75rem] text-m-faint">—</span>
                )}
              </span>
            ))}
          </div>
        )
      })}
    </MAdminCard>
  )
}
