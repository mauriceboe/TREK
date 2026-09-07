import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Bell, Link2, Send } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { notificationsApi, settingsApi } from '../../../api/client'
import { useToast } from '../../../components/shared/Toast'
import { MSetCard, MSetEyebrow, MSetInput, MSetButton, MSetHint } from './MSettingsUi'
import MChip from '../../components/MChip'

interface ChannelDescriptor {
  id: string
  source: 'builtin' | 'plugin'
  /** Built-ins: an i18n key. */
  labelKey?: string
  /** Plugin channels: a literal name, already resolved by the server. */
  label?: string
  settingsPath?: string
  active: boolean
  configured: boolean
}

interface PreferencesMatrix {
  preferences: Record<string, Record<string, boolean>>
  channels: ChannelDescriptor[]
  event_types: string[]
  implemented_combos: Record<string, string[]>
  defaults?: { ntfyServer: string | null }
}

function channelLabel(ch: ChannelDescriptor, t: (k: string) => string): string {
  if (ch.labelKey) return t(ch.labelKey) || ch.id
  return ch.label || ch.id
}

const EVENT_LABEL_KEYS: Record<string, string> = {
  trip_invite: 'settings.notifyTripInvite',
  booking_change: 'settings.notifyBookingChange',
  trip_reminder: 'settings.notifyTripReminder',
  todo_due: 'settings.notifyTodoDue',
  vacay_invite: 'settings.notifyVacayInvite',
  vacay_share: 'settings.notifyVacayShare',
  collection_invite: 'settings.notifyCollectionInvite',
  synology_session_cleared: 'settings.notifySynologySessionCleared',
  plugin_notification: 'settings.notifyPluginNotification',
  photos_shared: 'settings.notifyPhotosShared',
  collab_message: 'settings.notifyCollabMessage',
  packing_tagged: 'settings.notifyPackingTagged',
  version_available: 'settings.notifyVersionAvailable',
}

const MASKED = '••••••••'

/**
 * "Notifications" section — NotificationsTab parity: webhook + ntfy channel
 * credentials, plugin channels and the event/channel preference matrix,
 * rendered as chip rows instead of the desktop grid.
 */
export default function MSettingsNotifications() {
  const { t } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const [matrix, setMatrix] = useState<PreferencesMatrix | null>(null)
  const [saving, setSaving] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookIsSet, setWebhookIsSet] = useState(false)
  const [webhookSaving, setWebhookSaving] = useState(false)
  const [webhookTesting, setWebhookTesting] = useState(false)
  const [ntfyTopic, setNtfyTopic] = useState('')
  const [ntfyServer, setNtfyServer] = useState('')
  const [ntfyToken, setNtfyToken] = useState('')
  const [ntfyTokenIsSet, setNtfyTokenIsSet] = useState(false)
  const [ntfySaving, setNtfySaving] = useState(false)
  const [ntfyTesting, setNtfyTesting] = useState(false)
  const [channelTesting, setChannelTesting] = useState<string | null>(null)

  useEffect(() => {
    notificationsApi.getPreferences().then((data: PreferencesMatrix) => setMatrix(data)).catch(() => {})
    settingsApi.get().then((data: { settings: Record<string, unknown> }) => {
      const val = (data.settings?.webhook_url as string) || ''
      if (val === MASKED) {
        setWebhookIsSet(true)
        setWebhookUrl('')
      } else {
        setWebhookUrl(val)
      }
      setNtfyTopic((data.settings?.ntfy_topic as string) || '')
      setNtfyServer((data.settings?.ntfy_server as string) || '')
      const rawToken = (data.settings?.ntfy_token as string) || ''
      if (rawToken === MASKED) {
        setNtfyTokenIsSet(true)
        setNtfyToken('')
      } else {
        setNtfyToken(rawToken)
      }
    }).catch(() => {})
  }, [])

  const visibleChannels = matrix
    ? matrix.channels.filter((ch) => {
        if (!ch.active) return false
        return matrix.event_types.some((evt) => matrix.implemented_combos[evt]?.includes(ch.id))
      })
    : []

  const hasChannel = (id: string) => matrix?.channels.some((ch) => ch.id === id && ch.active) ?? false
  const pluginChannels = matrix?.channels.filter((ch) => ch.source === 'plugin' && ch.active) ?? []

  const testChannel = async (ch: ChannelDescriptor) => {
    setChannelTesting(ch.id)
    try {
      const result = await notificationsApi.testChannel(ch.id)
      if (result.success) toast.success(t('settings.notificationPreferences.testSuccess'))
      else toast.error(result.error || t('settings.notificationPreferences.testFailed'))
    } catch {
      toast.error(t('settings.notificationPreferences.testFailed'))
    } finally {
      setChannelTesting(null)
    }
  }

  const toggle = async (eventType: string, channel: string) => {
    if (!matrix) return
    const current = matrix.preferences[eventType]?.[channel] ?? true
    const updated = {
      ...matrix.preferences,
      [eventType]: { ...matrix.preferences[eventType], [channel]: !current },
    }
    setMatrix((m) => (m ? { ...m, preferences: updated } : m))
    setSaving(true)
    try {
      await notificationsApi.updatePreferences(updated)
    } catch {
      // Only this cell rolls back — restoring the whole snapshot would also undo a
      // toggle the user made while this request was in flight.
      setMatrix((m) => (m ? {
        ...m,
        preferences: { ...m.preferences, [eventType]: { ...m.preferences[eventType], [channel]: current } },
      } : m))
      toast.error(t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  const saveWebhookUrl = async () => {
    setWebhookSaving(true)
    try {
      await settingsApi.set('webhook_url', webhookUrl)
      setWebhookIsSet(!!webhookUrl)
      toast.success(t('settings.webhookUrl.saved'))
    } catch {
      toast.error(t('common.error'))
    } finally {
      setWebhookSaving(false)
    }
  }

  const testWebhookUrl = async () => {
    if (!webhookUrl && !webhookIsSet) return
    setWebhookTesting(true)
    try {
      const result = await notificationsApi.testWebhook(webhookUrl || undefined)
      if (result.success) toast.success(t('settings.webhookUrl.testSuccess'))
      else toast.error(result.error || t('settings.webhookUrl.testFailed'))
    } catch {
      toast.error(t('settings.webhookUrl.testFailed'))
    } finally {
      setWebhookTesting(false)
    }
  }

  const saveNtfySettings = async () => {
    setNtfySaving(true)
    try {
      await settingsApi.setBulk({
        ntfy_topic: ntfyTopic,
        ntfy_server: ntfyServer,
        ...(ntfyToken && ntfyToken !== MASKED ? { ntfy_token: ntfyToken } : {}),
      })
      if (ntfyToken && ntfyToken !== MASKED) setNtfyTokenIsSet(true)
      toast.success(t('settings.ntfyUrl.saved'))
    } catch {
      toast.error(t('common.error'))
    } finally {
      setNtfySaving(false)
    }
  }

  const clearNtfyToken = async () => {
    try {
      await settingsApi.set('ntfy_token', '')
      setNtfyToken('')
      setNtfyTokenIsSet(false)
      toast.success(t('settings.ntfyUrl.tokenCleared'))
    } catch {
      toast.error(t('common.error'))
    }
  }

  const testNtfySettings = async () => {
    if (!ntfyTopic) return
    setNtfyTesting(true)
    try {
      const result = await notificationsApi.testNtfy({
        topic: ntfyTopic,
        server: ntfyServer || null,
        token: ntfyToken && ntfyToken !== MASKED ? ntfyToken : null,
      })
      if (result.success) toast.success(t('settings.ntfyUrl.testSuccess'))
      else toast.error(result.error || t('settings.ntfyUrl.testFailed'))
    } catch {
      toast.error(t('settings.ntfyUrl.testFailed'))
    } finally {
      setNtfyTesting(false)
    }
  }

  return (
    <MSetCard title={t('settings.notifications')} icon={Bell}>
      {!matrix && <p className="font-geist text-[0.6875rem] italic text-m-faint">{t('common.loading')}</p>}

      {matrix && visibleChannels.length === 0 && (
        <p className="font-geist text-[0.6875rem] italic text-m-faint">{t('settings.notificationPreferences.noChannels')}</p>
      )}

      {matrix && visibleChannels.length > 0 && (
        <>
          {hasChannel('webhook') && (
            <div className="mb-3 rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheet)] p-3">
              <MSetEyebrow className="mb-1">{t('settings.webhookUrl.label')}</MSetEyebrow>
              <MSetHint className="mb-2 mt-0">{t('settings.webhookUrl.hint')}</MSetHint>
              <MSetInput
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder={webhookIsSet ? MASKED : t('settings.webhookUrl.placeholder')}
              />
              <div className="mt-2 flex gap-2">
                <MSetButton onClick={saveWebhookUrl} disabled={webhookSaving}>
                  {t('common.save')}
                </MSetButton>
                <MSetButton variant="ghost" onClick={testWebhookUrl} disabled={(!webhookUrl && !webhookIsSet) || webhookTesting}>
                  <Send size={13} />
                  {t('settings.webhookUrl.test')}
                </MSetButton>
              </div>
            </div>
          )}

          {hasChannel('ntfy') && (
            <div className="mb-3 rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheet)] p-3">
              <MSetEyebrow className="mb-1">{t('settings.ntfyUrl.topicLabel')}</MSetEyebrow>
              <MSetHint className="mb-2 mt-0">{t('settings.ntfyUrl.hint')}</MSetHint>
              <MSetInput value={ntfyTopic} onChange={(e) => setNtfyTopic(e.target.value)} placeholder={t('settings.ntfyUrl.topicPlaceholder')} />
              <MSetEyebrow className="mb-1 mt-3">{t('settings.ntfyUrl.serverLabel')}</MSetEyebrow>
              <MSetInput
                value={ntfyServer}
                onChange={(e) => setNtfyServer(e.target.value)}
                placeholder={matrix.defaults?.ntfyServer || t('settings.ntfyUrl.serverPlaceholder')}
              />
              <MSetEyebrow className="mb-1 mt-3">{t('settings.ntfyUrl.tokenLabel')}</MSetEyebrow>
              <MSetHint className="mb-2 mt-0">{t('settings.ntfyUrl.tokenHint')}</MSetHint>
              <MSetInput
                type="password"
                value={ntfyToken}
                onChange={(e) => setNtfyToken(e.target.value)}
                placeholder={ntfyTokenIsSet ? MASKED : ''}
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <MSetButton onClick={saveNtfySettings} disabled={ntfySaving}>
                  {t('common.save')}
                </MSetButton>
                <MSetButton variant="ghost" onClick={testNtfySettings} disabled={!ntfyTopic || ntfyTesting}>
                  <Send size={13} />
                  {t('settings.ntfyUrl.test')}
                </MSetButton>
                {ntfyTokenIsSet && (
                  <MSetButton variant="danger" onClick={clearNtfyToken}>
                    {t('common.clear')}
                  </MSetButton>
                )}
              </div>
            </div>
          )}

          {pluginChannels.map((ch) => (
            <div key={ch.id} className="mb-3 rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheet)] p-3">
              <MSetEyebrow className="mb-1">{channelLabel(ch, t)}</MSetEyebrow>
              <MSetHint className="mb-2 mt-0">
                {ch.configured
                  ? t('settings.notificationPreferences.pluginConfigured')
                  : t('settings.notificationPreferences.notConfigured')}
              </MSetHint>
              <div className="flex gap-2">
                {!ch.configured && ch.settingsPath && (
                  <MSetButton onClick={() => navigate(ch.settingsPath!)}>
                    <Link2 size={13} />
                    {t('settings.notificationPreferences.configure')}
                  </MSetButton>
                )}
                <MSetButton variant="ghost" onClick={() => testChannel(ch)} disabled={!ch.configured || channelTesting === ch.id}>
                  <Send size={13} />
                  {t('settings.notificationPreferences.sendTest')}
                </MSetButton>
              </div>
            </div>
          ))}

          {saving && <p className="mb-1 font-geist text-[0.625rem] text-m-faint">{t('common.saving')}</p>}

          {/* Event → channel matrix as chip rows: tap a channel chip to toggle it. */}
          {matrix.event_types.map((eventType, i) => {
            const implementedForEvent = matrix.implemented_combos[eventType] ?? []
            const relevantChannels = visibleChannels.filter((ch) => implementedForEvent.includes(ch.id))
            if (relevantChannels.length === 0) return null
            return (
              <div key={eventType} className={`py-[10px] ${i > 0 ? 'border-t border-[color:var(--m-rowbr)]' : ''}`}>
                <div className="mb-[7px] text-[0.78125rem] font-bold text-m-ink">
                  {t(EVENT_LABEL_KEYS[eventType]) || eventType}
                </div>
                <div className="flex flex-wrap gap-[6px]">
                  {relevantChannels.map((ch) => {
                    const isOn = matrix.preferences[eventType]?.[ch.id] ?? true
                    return (
                      <MChip key={ch.id} active={isOn} onClick={() => toggle(eventType, ch.id)}>
                        {channelLabel(ch, t)}
                      </MChip>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </>
      )}
    </MSetCard>
  )
}
