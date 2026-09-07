import React, { useState, useEffect } from 'react'
import { Link } from 'react-router'
import { Lock } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { notificationsApi, settingsApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import ToggleSwitch from './ToggleSwitch'
import Section from './Section'

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

/** Plugin channels have no i18n — the server sends their display name outright. */
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

export default function NotificationsTab(): React.ReactElement {
  const { t } = useTranslation()
  const toast = useToast()
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
      if (val === '••••••••') {
        setWebhookIsSet(true)
        setWebhookUrl('')
      } else {
        setWebhookUrl(val)
      }
      setNtfyTopic((data.settings?.ntfy_topic as string) || '')
      setNtfyServer((data.settings?.ntfy_server as string) || '')
      const rawToken = (data.settings?.ntfy_token as string) || ''
      if (rawToken === '••••••••') {
        setNtfyTokenIsSet(true)
        setNtfyToken('')
      } else {
        setNtfyToken(rawToken)
      }
    }).catch(() => {})
  }, [])

  // Columns are whatever the server says exists and the admin turned on — so a
  // plugin channel gets a column here with no client change.
  const visibleChannels = matrix
    ? matrix.channels.filter(ch => {
        if (!ch.active) return false
        return matrix.event_types.some(evt => matrix.implemented_combos[evt]?.includes(ch.id))
      })
    : []

  const hasChannel = (id: string) => matrix?.channels.some(ch => ch.id === id && ch.active) ?? false

  // Plugin channels have no bespoke credential form here — the user fills those in on the
  // plugin's own settings page. What they DO get is a test send, through the generic route.
  const pluginChannels = matrix?.channels.filter(ch => ch.source === 'plugin' && ch.active) ?? []

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
    setMatrix(m => m ? {
      ...m,
      preferences: { ...m.preferences, [eventType]: { ...m.preferences[eventType], [channel]: !current } },
    } : m)
    setSaving(true)
    try {
      // Only the toggled cell goes out. The server merges what it gets, and sending the
      // whole matrix would carry this render's value for every other cell — a second
      // toggle made while this request is in flight would be overwritten by it.
      await notificationsApi.updatePreferences({ [eventType]: { [channel]: !current } })
    } catch {
      // Only this cell rolls back — restoring the whole snapshot would also undo a
      // toggle the user made while this request was in flight.
      setMatrix(m => m ? {
        ...m,
        preferences: { ...m.preferences, [eventType]: { ...m.preferences[eventType], [channel]: current } },
      } : m)
      toast.error(t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  const saveWebhookUrl = async () => {
    setWebhookSaving(true)
    try {
      await settingsApi.set('webhook_url', webhookUrl)
      if (webhookUrl) setWebhookIsSet(true)
      else setWebhookIsSet(false)
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
        ...(ntfyToken ? { ntfy_token: ntfyToken } : {}),
      })
      if (ntfyToken) setNtfyTokenIsSet(true)
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
        // A stored token is only masked in the placeholder, never in state — sending
        // null makes the server fall back to the saved one.
        token: ntfyToken || null,
      })
      if (result.success) toast.success(t('settings.ntfyUrl.testSuccess'))
      else toast.error(result.error || t('settings.ntfyUrl.testFailed'))
    } catch {
      toast.error(t('settings.ntfyUrl.testFailed'))
    } finally {
      setNtfyTesting(false)
    }
  }

  const renderContent = () => {
    if (!matrix) return <p style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', color: 'var(--text-faint)', fontStyle: 'italic' }}>{t('common.loading')}</p>

    if (visibleChannels.length === 0) {
      return (
        <p style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', color: 'var(--text-faint)', fontStyle: 'italic' }}>
          {t('settings.notificationPreferences.noChannels')}
        </p>
      )
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {saving && <p style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', color: 'var(--text-faint)', marginBottom: 8 }}>{t('common.saving')}</p>}
        {hasChannel('webhook') && (
          <div style={{ marginBottom: 16, padding: '12px', background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border-primary)' }}>
            <label style={{ display: 'block', fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {t('settings.webhookUrl.label')}
            </label>
            <p style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', color: 'var(--text-faint)', marginBottom: 8 }}>{t('settings.webhookUrl.hint')}</p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={webhookUrl}
                onChange={e => setWebhookUrl(e.target.value)}
                placeholder={webhookIsSet ? '••••••••' : t('settings.webhookUrl.placeholder')}
                style={{ flex: 1, fontSize: 'calc(13px * var(--fs-scale-body, 1))', padding: '6px 10px', border: '1px solid var(--border-primary)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
              />
              <button type="button"
                onClick={saveWebhookUrl}
                disabled={webhookSaving}
                style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', padding: '6px 12px', background: 'var(--text-primary)', color: 'var(--bg-primary)', border: 'none', borderRadius: 6, cursor: webhookSaving ? 'not-allowed' : 'pointer', opacity: webhookSaving ? 0.6 : 1 }}
              >
                {t('common.save')}
              </button>
              <button type="button"
                onClick={testWebhookUrl}
                disabled={(!webhookUrl && !webhookIsSet) || webhookTesting}
                style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', padding: '6px 12px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-primary)', borderRadius: 6, cursor: ((!webhookUrl && !webhookIsSet) || webhookTesting) ? 'not-allowed' : 'pointer', opacity: ((!webhookUrl && !webhookIsSet) || webhookTesting) ? 0.5 : 1 }}
              >
                {t('settings.webhookUrl.test')}
              </button>
            </div>
          </div>
        )}
        {hasChannel('ntfy') && (
          <div style={{ marginBottom: 16, padding: '12px', background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border-primary)' }}>
            <label style={{ display: 'block', fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {t('settings.ntfyUrl.topicLabel')}
            </label>
            <p style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', color: 'var(--text-faint)', marginBottom: 8 }}>{t('settings.ntfyUrl.hint')}</p>
            <input
              type="text"
              value={ntfyTopic}
              onChange={e => setNtfyTopic(e.target.value)}
              placeholder={t('settings.ntfyUrl.topicPlaceholder')}
              style={{ width: '100%', boxSizing: 'border-box', fontSize: 'calc(13px * var(--fs-scale-body, 1))', padding: '6px 10px', border: '1px solid var(--border-primary)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', marginBottom: 6 }}
            />
            <label style={{ display: 'block', fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {t('settings.ntfyUrl.serverLabel')}
            </label>
            <input
              type="text"
              value={ntfyServer}
              onChange={e => setNtfyServer(e.target.value)}
              placeholder={matrix.defaults?.ntfyServer || t('settings.ntfyUrl.serverPlaceholder')}
              style={{ width: '100%', boxSizing: 'border-box', fontSize: 'calc(13px * var(--fs-scale-body, 1))', padding: '6px 10px', border: '1px solid var(--border-primary)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', marginBottom: 6 }}
            />
            <label style={{ display: 'block', fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {t('settings.ntfyUrl.tokenLabel')}
            </label>
            <p style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', color: 'var(--text-faint)', marginBottom: 4 }}>{t('settings.ntfyUrl.tokenHint')}</p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="password"
                value={ntfyToken}
                onChange={e => setNtfyToken(e.target.value)}
                placeholder={ntfyTokenIsSet ? '••••••••' : ''}
                style={{ flex: 1, fontSize: 'calc(13px * var(--fs-scale-body, 1))', padding: '6px 10px', border: '1px solid var(--border-primary)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
              />
              {ntfyTokenIsSet && (
                <button type="button"
                  onClick={clearNtfyToken}
                  style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', padding: '6px 12px', background: 'transparent', color: 'var(--color-danger, #e53e3e)', border: '1px solid var(--color-danger, #e53e3e)', borderRadius: 6, cursor: 'pointer' }}
                >
                  {t('common.clear')}
                </button>
              )}
              <button type="button"
                onClick={saveNtfySettings}
                disabled={ntfySaving}
                style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', padding: '6px 12px', background: 'var(--text-primary)', color: 'var(--bg-primary)', border: 'none', borderRadius: 6, cursor: ntfySaving ? 'not-allowed' : 'pointer', opacity: ntfySaving ? 0.6 : 1 }}
              >
                {t('common.save')}
              </button>
              <button type="button"
                onClick={testNtfySettings}
                disabled={!ntfyTopic || ntfyTesting}
                style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', padding: '6px 12px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-primary)', borderRadius: 6, cursor: (!ntfyTopic || ntfyTesting) ? 'not-allowed' : 'pointer', opacity: (!ntfyTopic || ntfyTesting) ? 0.5 : 1 }}
              >
                {t('settings.ntfyUrl.test')}
              </button>
            </div>
          </div>
        )}
        {pluginChannels.map(ch => (
          <div key={ch.id} style={{ marginBottom: 16, padding: '12px', background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border-primary)' }}>
            <label style={{ display: 'block', fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {channelLabel(ch, t)}
            </label>
            <p style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', color: 'var(--text-faint)', marginBottom: 8 }}>
              {ch.configured
                ? t('settings.notificationPreferences.pluginConfigured')
                : t('settings.notificationPreferences.notConfigured')}
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {/* Unconfigured is the common case on first use — send them to where the
                  credentials actually live rather than just naming the place. */}
              {!ch.configured && ch.settingsPath && (
                <Link
                  to={ch.settingsPath}
                  style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', padding: '6px 12px', background: 'var(--text-primary)', color: 'var(--bg-primary)', border: 'none', borderRadius: 6, textDecoration: 'none' }}
                >
                  {t('settings.notificationPreferences.configure')}
                </Link>
              )}
              <button type="button"
                onClick={() => testChannel(ch)}
                disabled={!ch.configured || channelTesting === ch.id}
                style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', padding: '6px 12px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-primary)', borderRadius: 6, cursor: (!ch.configured || channelTesting === ch.id) ? 'not-allowed' : 'pointer', opacity: (!ch.configured || channelTesting === ch.id) ? 0.5 : 1 }}
              >
                {t('settings.notificationPreferences.sendTest')}
              </button>
            </div>
          </div>
        ))}
        {/* Header row */}
        <div style={{ display: 'grid', gridTemplateColumns: `1fr ${visibleChannels.map(() => '64px').join(' ')}`, gap: 4, paddingBottom: 6, marginBottom: 4, borderBottom: '1px solid var(--border-primary)' }}>
          <span />
          {visibleChannels.map(ch => (
            <span key={ch.id} title={!ch.configured ? t('settings.notificationPreferences.notConfigured') : undefined} style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', fontWeight: 600, color: ch.configured ? 'var(--text-faint)' : 'var(--color-warning, #d69e2e)', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {channelLabel(ch, t)}
            </span>
          ))}
        </div>
        {/* Event rows */}
        {matrix.event_types.map(eventType => {
          const implementedForEvent = matrix.implemented_combos[eventType] ?? []
          const relevantChannels = visibleChannels.filter(ch => implementedForEvent.includes(ch.id))
          if (relevantChannels.length === 0) return null
          return (
            <div key={eventType} style={{ display: 'grid', gridTemplateColumns: `1fr ${visibleChannels.map(() => '64px').join(' ')}`, gap: 4, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border-primary)' }}>
              <span style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', color: 'var(--text-primary)' }}>
                {t(EVENT_LABEL_KEYS[eventType]) || eventType}
              </span>
              {visibleChannels.map(ch => {
                if (!implementedForEvent.includes(ch.id)) {
                  return <span key={ch.id} style={{ textAlign: 'center', color: 'var(--text-faint)', fontSize: 'calc(14px * var(--fs-scale-body, 1))' }}>—</span>
                }
                const isOn = matrix.preferences[eventType]?.[ch.id] ?? true
                return (
                  <div key={ch.id} style={{ display: 'flex', justifyContent: 'center' }}>
                    <ToggleSwitch on={isOn} onToggle={() => toggle(eventType, ch.id)} />
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <Section title={t('settings.notifications')} icon={Lock}>
      {renderContent()}
    </Section>
  )
}
