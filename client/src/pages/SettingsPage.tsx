import React, { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useSettingsStore } from '../store/settingsStore'
import { SUPPORTED_LANGUAGES, useTranslation } from '../i18n'
import Navbar from '../components/Layout/Navbar'

import { useToast } from '../components/shared/Toast'
import { Save, Palette, User, Moon, Sun, Monitor, Shield, Camera, Trash2, Lock, KeyRound, AlertTriangle, Copy, Download, Printer, Terminal, Plus, Check, Info } from 'lucide-react'
import { authApi, adminApi } from '../api/client'
import apiClient from '../api/client'
import { useAddonStore } from '../store/addonStore'
import type { LucideIcon } from 'lucide-react'
import type { UserWithOidc } from '../types'
import { getApiErrorMessage } from '../types'
const MFA_BACKUP_SESSION_KEY = 'trek_mfa_backup_codes_pending'
interface McpToken {
  id: number
  name: string
  token_prefix: string
  created_at: string
  last_used_at: string | null
}


interface SectionProps {
  title: string
  icon: LucideIcon
  children: React.ReactNode
}

function Section({ title, icon: Icon, children }: SectionProps): React.ReactElement {
  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)', breakInside: 'avoid', marginBottom: 24 }}>
      <div className="px-6 py-4 border-b flex items-center gap-2" style={{ borderColor: 'var(--border-secondary)' }}>
        <Icon className="w-5 h-5" style={{ color: 'var(--text-secondary)' }} />
        <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
      </div>
      <div className="p-6 space-y-4">
        {children}
      </div>
    </div>
  )
}

function ToggleSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle}
      style={{
        position: 'relative', width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
        background: on ? 'var(--accent, #111827)' : 'var(--border-primary, #d1d5db)',
        transition: 'background 0.2s',
      }}>
      <span style={{
        position: 'absolute', top: 2, left: on ? 22 : 2,
        width: 20, height: 20, borderRadius: '50%', background: 'white',
        transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }} />
    </button>
  )
}

function NotificationPreferences({ t }: { t: any; memoriesEnabled: boolean }) {
  const [notifChannel, setNotifChannel] = useState<string>('none')
  useEffect(() => {
    authApi.getAppConfig?.().then((cfg: any) => {
      if (cfg?.notification_channel) setNotifChannel(cfg.notification_channel)
    }).catch(() => {})
  }, [])

  if (notifChannel === 'none') {
    return (
      <p style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic' }}>
        {t('settings.notificationsDisabled')}
      </p>
    )
  }

  const channelLabel = notifChannel === 'email'
    ? (t('admin.notifications.email') || 'Email (SMTP)')
    : (t('admin.notifications.webhook') || 'Webhook')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
        <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>
          {t('settings.notificationsActive')}: {channelLabel}
        </span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0, lineHeight: 1.5 }}>
        {t('settings.notificationsManagedByAdmin')}
      </p>
    </div>
  )
}

export default function SettingsPage(): React.ReactElement {
  const { user, updateProfile, uploadAvatar, deleteAvatar, logout, loadUser, demoMode, appRequireMfa } = useAuthStore()
  const [searchParams] = useSearchParams()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean | 'blocked'>(false)
  const avatarInputRef = React.useRef<HTMLInputElement>(null)
  const { settings, updateSetting, updateSettings } = useSettingsStore()
  const { isEnabled: addonEnabled, loadAddons } = useAddonStore()
  const { t, locale } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()

  const [saving, setSaving] = useState<Record<string, boolean>>({})

  // Addon gating (derived from store)
  const memoriesEnabled = addonEnabled('memories')
  const mcpEnabled = addonEnabled('mcp')
  const [appVersion, setAppVersion] = useState<string | null>(null)
  useEffect(() => {
    authApi.getAppConfig?.().then(c => setAppVersion(c?.version)).catch(() => {})
  }, [])
  const [immichUrl, setImmichUrl] = useState('')
  const [immichApiKey, setImmichApiKey] = useState('')
  const [immichConnected, setImmichConnected] = useState(false)
  const [immichTesting, setImmichTesting] = useState(false)


  useEffect(() => {
    loadAddons()
  }, [])

  useEffect(() => {
    if (memoriesEnabled) {
      apiClient.get('/integrations/immich/settings').then(r2 => {
        setImmichUrl(r2.data.immich_url || '')
        setImmichConnected(r2.data.connected)
      }).catch(() => {})
    }
  }, [memoriesEnabled])

  const [immichTestPassed, setImmichTestPassed] = useState(false)

  const handleSaveImmich = async () => {
    setSaving(s => ({ ...s, immich: true }))
    try {
      const saveRes = await apiClient.put('/integrations/immich/settings', { immich_url: immichUrl, immich_api_key: immichApiKey || undefined })
      if (saveRes.data.warning) toast.warning(saveRes.data.warning)
      toast.success(t('memories.saved'))
      const res = await apiClient.get('/integrations/immich/status')
      setImmichConnected(res.data.connected)
      setImmichTestPassed(false)
    } catch {
      toast.error(t('memories.connectionError'))
    } finally {
      setSaving(s => ({ ...s, immich: false }))
    }
  }

  const handleTestImmich = async () => {
    setImmichTesting(true)
    try {
      const res = await apiClient.post('/integrations/immich/test', { immich_url: immichUrl, immich_api_key: immichApiKey })
      if (res.data.connected) {
        if (res.data.canonicalUrl) {
          setImmichUrl(res.data.canonicalUrl)
          toast.success(`${t('memories.connectionSuccess')} — ${res.data.user?.name || ''} (URL updated to ${res.data.canonicalUrl})`)
        } else {
          toast.success(`${t('memories.connectionSuccess')} — ${res.data.user?.name || ''}`)
        }
        setImmichTestPassed(true)
      } else {
        toast.error(`${t('memories.connectionError')}: ${res.data.error}`)
        setImmichTestPassed(false)
      }
    } catch {
      toast.error(t('memories.connectionError'))
    } finally {
      setImmichTesting(false)
    }
  }

  // MCP tokens
  const [mcpTokens, setMcpTokens] = useState<McpToken[]>([])
  const [mcpModalOpen, setMcpModalOpen] = useState(false)
  const [mcpNewName, setMcpNewName] = useState('')
  const [mcpCreatedToken, setMcpCreatedToken] = useState<string | null>(null)
  const [mcpCreating, setMcpCreating] = useState(false)
  const [mcpDeleteId, setMcpDeleteId] = useState<number | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  useEffect(() => {
    if (authApi.mcpTokens) {
      authApi.mcpTokens.list().then(d => setMcpTokens(d.tokens || [])).catch(() => {})
    }
  }, [])

  const handleCreateMcpToken = async () => {
    if (!mcpNewName.trim()) return
    setMcpCreating(true)
    try {
      const d = await authApi.mcpTokens.create(mcpNewName.trim())
      setMcpCreatedToken(d.token.raw_token)
      setMcpNewName('')
      setMcpTokens(prev => [{ id: d.token.id, name: d.token.name, token_prefix: d.token.token_prefix, created_at: d.token.created_at, last_used_at: null }, ...prev])
    } catch {
      toast.error(t('settings.mcp.toast.createError'))
    } finally {
      setMcpCreating(false)
    }
  }

  const handleDeleteMcpToken = async (id: number) => {
    try {
      await authApi.mcpTokens.delete(id)
      setMcpTokens(prev => prev.filter(tk => tk.id !== id))
      setMcpDeleteId(null)
      toast.success(t('settings.mcp.toast.deleted'))
    } catch {
      toast.error(t('settings.mcp.toast.deleteError'))
    }
  }

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 2000)
    })
  }

  const mcpEndpoint = `${window.location.origin}/mcp`
  const mcpJsonConfig = `{
  "mcpServers": {
    "trek": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "${mcpEndpoint}",
        "--header",
        "Authorization: Bearer <your_token>"
      ]
    }
  }
}`

  // Display
  const [tempUnit, setTempUnit] = useState<string>(settings.temperature_unit || 'celsius')

  // Account
  const [username, setUsername] = useState<string>(user?.username || '')
  const [email, setEmail] = useState<string>(user?.email || '')
  const [currentPassword, setCurrentPassword] = useState<string>('')
  const [newPassword, setNewPassword] = useState<string>('')
  const [confirmPassword, setConfirmPassword] = useState<string>('')
  const [oidcOnlyMode, setOidcOnlyMode] = useState<boolean>(false)

  useEffect(() => {
    authApi.getAppConfig?.().then((config) => {
      if (config?.oidc_only_mode) setOidcOnlyMode(true)
    }).catch(() => {})
  }, [])

  const [mfaQr, setMfaQr] = useState<string | null>(null)
  const [mfaSecret, setMfaSecret] = useState<string | null>(null)
  const [mfaSetupCode, setMfaSetupCode] = useState('')
  const [mfaDisablePwd, setMfaDisablePwd] = useState('')
  const [mfaDisableCode, setMfaDisableCode] = useState('')
  const [mfaLoading, setMfaLoading] = useState(false)
  const mfaRequiredByPolicy =
    !demoMode &&
    !user?.mfa_enabled &&
    (searchParams.get('mfa') === 'required' || appRequireMfa)

  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)

  const backupCodesText = backupCodes?.join('\n') || ''

  // Restore backup codes panel after refresh (loadUser silent fix + sessionStorage)
  useEffect(() => {
    if (!user?.mfa_enabled || backupCodes) return
    try {
      const raw = sessionStorage.getItem(MFA_BACKUP_SESSION_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => typeof x === 'string')) {
        setBackupCodes(parsed)
      }
    } catch {
      sessionStorage.removeItem(MFA_BACKUP_SESSION_KEY)
    }
  }, [user?.mfa_enabled, backupCodes])

  const dismissBackupCodes = (): void => {
    sessionStorage.removeItem(MFA_BACKUP_SESSION_KEY)
    setBackupCodes(null)
  }

  const copyBackupCodes = async (): Promise<void> => {
    if (!backupCodesText) return
    try {
      await navigator.clipboard.writeText(backupCodesText)
      toast.success(t('settings.mfa.backupCopied'))
    } catch {
      toast.error(t('common.error'))
    }
  }

  const downloadBackupCodes = (): void => {
    if (!backupCodesText) return
    const blob = new Blob([backupCodesText + '\n'], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'trek-mfa-backup-codes.txt'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const printBackupCodes = (): void => {
    if (!backupCodesText) return
    const html = `<!doctype html><html><head><meta charset="utf-8"/><title>TREK MFA Backup Codes</title>
      <style>body{font-family:Arial,sans-serif;padding:32px}h1{font-size:20px}pre{font-size:16px;line-height:1.6}</style>
      </head><body><h1>TREK MFA Backup Codes</h1><p>${new Date().toLocaleString()}</p><pre>${backupCodesText}</pre></body></html>`
    const w = window.open('', '_blank', 'width=900,height=700')
    if (!w) return
    w.document.open()
    w.document.write(html)
    w.document.close()
    w.focus()
    w.print()
  }

  useEffect(() => {
    setTempUnit(settings.temperature_unit || 'celsius')
  }, [settings])

  useEffect(() => {
    setUsername(user?.username || '')
    setEmail(user?.email || '')
  }, [user])



  const saveDisplay = async (): Promise<void> => {
    setSaving(s => ({ ...s, display: true }))
    try {
      await updateSetting('temperature_unit', tempUnit)
      toast.success(t('settings.toast.displaySaved'))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Error')
    } finally {
      setSaving(s => ({ ...s, display: false }))
    }
  }

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      await uploadAvatar(file)
      toast.success(t('settings.avatarUploaded'))
    } catch {
      toast.error(t('settings.avatarError'))
    }
    if (avatarInputRef.current) avatarInputRef.current.value = ''
  }

  const handleAvatarRemove = async (): Promise<void> => {
    try {
      await deleteAvatar()
      toast.success(t('settings.avatarRemoved'))
    } catch {
      toast.error(t('settings.avatarError'))
    }
  }

  const saveProfile = async (): Promise<void> => {
    setSaving(s => ({ ...s, profile: true }))
    try {
      await updateProfile({ username, email })
      toast.success(t('settings.toast.profileSaved'))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Error')
    } finally {
      setSaving(s => ({ ...s, profile: false }))
    }
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-secondary)' }}>
      <Navbar />

      <div style={{ paddingTop: 'var(--nav-h)' }}>
        <div className="max-w-5xl mx-auto px-4 py-8">
          <style>{`@media (max-width: 900px) { .settings-columns { column-count: 1 !important; } }`}</style>
          <div style={{ marginBottom: 24 }}>
            <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.title')}</h1>
            <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>{t('settings.subtitle')}</p>
          </div>

          <div className="settings-columns" style={{ columnCount: 2, columnGap: 24 }}>

          {/* Display */}
          <Section title={t('settings.display')} icon={Palette}>
            {/* Dark Mode Toggle */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.colorMode')}</label>
              <div className="flex gap-3">
                {[
                  { value: 'light', label: t('settings.light'), icon: Sun },
                  { value: 'dark', label: t('settings.dark'), icon: Moon },
                  { value: 'auto', label: t('settings.auto'), icon: Monitor },
                ].map(opt => {
                  const current = settings.dark_mode
                  const isActive = current === opt.value || (opt.value === 'light' && current === false) || (opt.value === 'dark' && current === true)
                  return (
                    <button
                      key={opt.value}
                      onClick={async () => {
                        try {
                          await updateSetting('dark_mode', opt.value)
                        } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Error') }
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '10px 20px', borderRadius: 10, cursor: 'pointer',
                        fontFamily: 'inherit', fontSize: 14, fontWeight: 500,
                        border: isActive ? '2px solid var(--text-primary)' : '2px solid var(--border-primary)',
                        background: isActive ? 'var(--bg-hover)' : 'var(--bg-card)',
                        color: 'var(--text-primary)',
                        transition: 'all 0.15s',
                      }}
                    >
                      <opt.icon size={16} />
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Sprache */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.language')}</label>
              <div className="flex flex-wrap gap-3">
                {SUPPORTED_LANGUAGES.map(opt => (
                  <button
                    key={opt.value}
                    onClick={async () => {
                      try { await updateSetting('language', opt.value) }
                      catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Error') }
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '10px 20px', borderRadius: 10, cursor: 'pointer',
                      fontFamily: 'inherit', fontSize: 14, fontWeight: 500,
                      border: settings.language === opt.value ? '2px solid var(--text-primary)' : '2px solid var(--border-primary)',
                      background: settings.language === opt.value ? 'var(--bg-hover)' : 'var(--bg-card)',
                      color: 'var(--text-primary)',
                      transition: 'all 0.15s',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Temperature */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.temperature')}</label>
              <div className="flex gap-3">
                {[
                  { value: 'celsius', label: '°C Celsius' },
                  { value: 'fahrenheit', label: '°F Fahrenheit' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={async () => {
                      setTempUnit(opt.value)
                      try { await updateSetting('temperature_unit', opt.value) }
                      catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Error') }
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '10px 20px', borderRadius: 10, cursor: 'pointer',
                      fontFamily: 'inherit', fontSize: 14, fontWeight: 500,
                      border: tempUnit === opt.value ? '2px solid var(--text-primary)' : '2px solid var(--border-primary)',
                      background: tempUnit === opt.value ? 'var(--bg-hover)' : 'var(--bg-card)',
                      color: 'var(--text-primary)',
                      transition: 'all 0.15s',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Zeitformat */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.timeFormat')}</label>
              <div className="flex gap-3">
                {[
                  { value: '24h', label: '24h (14:30)' },
                  { value: '12h', label: '12h (2:30 PM)' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={async () => {
                      try { await updateSetting('time_format', opt.value) }
                      catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Error') }
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '10px 20px', borderRadius: 10, cursor: 'pointer',
                      fontFamily: 'inherit', fontSize: 14, fontWeight: 500,
                      border: settings.time_format === opt.value ? '2px solid var(--text-primary)' : '2px solid var(--border-primary)',
                      background: settings.time_format === opt.value ? 'var(--bg-hover)' : 'var(--bg-card)',
                      color: 'var(--text-primary)',
                      transition: 'all 0.15s',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          {/* Route Calculation */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.routeCalculation')}</label>
              <div className="flex gap-3">
                {[
                  { value: true, label: t('settings.on') || 'On' },
                  { value: false, label: t('settings.off') || 'Off' },
                ].map(opt => (
                  <button
                    key={String(opt.value)}
                    onClick={async () => {
                      try { await updateSetting('route_calculation', opt.value) }
                      catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Error') }
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '10px 20px', borderRadius: 10, cursor: 'pointer',
                      fontFamily: 'inherit', fontSize: 14, fontWeight: 500,
                      border: (settings.route_calculation !== false) === opt.value ? '2px solid var(--text-primary)' : '2px solid var(--border-primary)',
                      background: (settings.route_calculation !== false) === opt.value ? 'var(--bg-hover)' : 'var(--bg-card)',
                      color: 'var(--text-primary)',
                      transition: 'all 0.15s',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

          {/* Blur Booking Codes */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.blurBookingCodes')}</label>
              <div className="flex gap-3">
                {[
                  { value: true, label: t('settings.on') || 'On' },
                  { value: false, label: t('settings.off') || 'Off' },
                ].map(opt => (
                  <button
                    key={String(opt.value)}
                    onClick={async () => {
                      try { await updateSetting('blur_booking_codes', opt.value) }
                      catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Error') }
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '10px 20px', borderRadius: 10, cursor: 'pointer',
                      fontFamily: 'inherit', fontSize: 14, fontWeight: 500,
                      border: (!!settings.blur_booking_codes) === opt.value ? '2px solid var(--text-primary)' : '2px solid var(--border-primary)',
                      background: (!!settings.blur_booking_codes) === opt.value ? 'var(--bg-hover)' : 'var(--bg-card)',
                      color: 'var(--text-primary)',
                      transition: 'all 0.15s',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </Section>

          {/* Notifications */}
          <Section title={t('settings.notifications')} icon={Lock}>
            <NotificationPreferences t={t} memoriesEnabled={memoriesEnabled} />
          </Section>

          {/* Immich — only when Memories addon is enabled */}
          {memoriesEnabled && (
            <Section title="Immich" icon={Camera}>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('memories.immichUrl')}</label>
                  <input type="url" value={immichUrl} onChange={e => { setImmichUrl(e.target.value); setImmichTestPassed(false) }}
                    placeholder="https://immich.example.com"
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-300" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('memories.immichApiKey')}</label>
                  <input type="password" value={immichApiKey} onChange={e => { setImmichApiKey(e.target.value); setImmichTestPassed(false) }}
                    placeholder={immichConnected ? '••••••••' : 'API Key'}
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-300" />
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={handleSaveImmich} disabled={saving.immich || !immichTestPassed}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:bg-slate-400"
                    title={!immichTestPassed ? t('memories.testFirst') : ''}>
                    <Save className="w-4 h-4" /> {t('common.save')}
                  </button>
                  <button onClick={handleTestImmich} disabled={immichTesting}
                    className="flex items-center gap-2 px-4 py-2 border border-slate-200 rounded-lg text-sm hover:bg-slate-50">
                    {immichTesting
                      ? <div className="w-4 h-4 border-2 border-slate-300 border-t-slate-700 rounded-full animate-spin" />
                      : <Camera className="w-4 h-4" />}
                    {t('memories.testConnection')}
                  </button>
                  {immichConnected && (
                    <span className="text-xs font-medium text-green-600 flex items-center gap-1">
                      <span className="w-2 h-2 bg-green-500 rounded-full" />
                      {t('memories.connected')}
                    </span>
                  )}
                </div>
              </div>
            </Section>
          )}

          {/* MCP Configuration — only when MCP addon is enabled */}
          {mcpEnabled && <Section title={t('settings.mcp.title')} icon={Terminal}>
            {/* Endpoint URL */}
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.endpoint')}</label>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 rounded-lg text-sm font-mono border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
                  {mcpEndpoint}
                </code>
                <button onClick={() => handleCopy(mcpEndpoint, 'endpoint')}
                  className="p-2 rounded-lg border transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                  style={{ borderColor: 'var(--border-primary)' }} title={t('settings.mcp.copy')}>
                  {copiedKey === 'endpoint' ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />}
                </button>
              </div>
            </div>

            {/* JSON config box */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.clientConfig')}</label>
                <button onClick={() => handleCopy(mcpJsonConfig, 'json')}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                  style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                  {copiedKey === 'json' ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                  {copiedKey === 'json' ? t('settings.mcp.copied') : t('settings.mcp.copy')}
                </button>
              </div>
              <pre className="p-3 rounded-lg text-xs font-mono overflow-x-auto border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
                {mcpJsonConfig}
              </pre>
              <p className="mt-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('settings.mcp.clientConfigHint')}</p>
            </div>

            {/* Token list */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apiTokens')}</label>
                <button onClick={() => { setMcpModalOpen(true); setMcpCreatedToken(null); setMcpNewName('') }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: 'var(--accent-primary, #4f46e5)', color: '#fff' }}>
                  <Plus className="w-3.5 h-3.5" /> {t('settings.mcp.createToken')}
                </button>
              </div>

              {mcpTokens.length === 0 ? (
                <p className="text-sm py-3 text-center rounded-lg border" style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-primary)' }}>
                  {t('settings.mcp.noTokens')}
                </p>
              ) : (
                <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-primary)' }}>
                  {mcpTokens.map((token, i) => (
                    <div key={token.id} className="flex items-center gap-3 px-4 py-3"
                      style={{ borderBottom: i < mcpTokens.length - 1 ? '1px solid var(--border-primary)' : undefined }}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{token.name}</p>
                        <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                          {token.token_prefix}...
                          <span className="ml-3 font-sans">{t('settings.mcp.tokenCreatedAt')} {new Date(token.created_at).toLocaleDateString(locale)}</span>
                          {token.last_used_at && (
                            <span className="ml-2">· {t('settings.mcp.tokenUsedAt')} {new Date(token.last_used_at).toLocaleDateString(locale)}</span>
                          )}
                        </p>
                      </div>
                      <button onClick={() => setMcpDeleteId(token.id)}
                        className="p-1.5 rounded-lg transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                        style={{ color: 'var(--text-tertiary)' }} title={t('settings.mcp.deleteTokenTitle')}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Section>}

          {/* Create MCP Token modal */}
          {mcpModalOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}
              onClick={e => { if (e.target === e.currentTarget && !mcpCreatedToken) { setMcpModalOpen(false) } }}>
              <div className="rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" style={{ background: 'var(--bg-card)' }}>
                {!mcpCreatedToken ? (
                  <>
                    <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.mcp.modal.createTitle')}</h3>
                    <div>
                      <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.modal.tokenName')}</label>
                      <input type="text" value={mcpNewName} onChange={e => setMcpNewName(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleCreateMcpToken()}
                        placeholder={t('settings.mcp.modal.tokenNamePlaceholder')}
                        className="w-full px-3 py-2.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                        style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                        autoFocus />
                    </div>
                    <div className="flex gap-2 justify-end pt-1">
                      <button onClick={() => setMcpModalOpen(false)}
                        className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                        {t('common.cancel')}
                      </button>
                      <button onClick={handleCreateMcpToken} disabled={!mcpNewName.trim() || mcpCreating}
                        className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                        style={{ background: 'var(--accent-primary, #4f46e5)' }}>
                        {mcpCreating ? t('settings.mcp.modal.creating') : t('settings.mcp.modal.create')}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.mcp.modal.createdTitle')}</h3>
                    <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-200" style={{ background: 'rgba(251,191,36,0.1)' }}>
                      <span className="text-amber-500 mt-0.5">⚠</span>
                      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.modal.createdWarning')}</p>
                    </div>
                    <div className="relative">
                      <pre className="p-3 pr-10 rounded-lg text-xs font-mono break-all border whitespace-pre-wrap" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
                        {mcpCreatedToken}
                      </pre>
                      <button onClick={() => handleCopy(mcpCreatedToken, 'new-token')}
                        className="absolute top-2 right-2 p-1.5 rounded transition-colors hover:bg-slate-200 dark:hover:bg-slate-600"
                        style={{ color: 'var(--text-secondary)' }} title={t('settings.mcp.copy')}>
                        {copiedKey === 'new-token' ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                    <div className="flex justify-end">
                      <button onClick={() => { setMcpModalOpen(false); setMcpCreatedToken(null) }}
                        className="px-4 py-2 rounded-lg text-sm font-medium text-white"
                        style={{ background: 'var(--accent-primary, #4f46e5)' }}>
                        {t('settings.mcp.modal.done')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Delete MCP Token confirm */}
          {mcpDeleteId !== null && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}
              onClick={e => { if (e.target === e.currentTarget) setMcpDeleteId(null) }}>
              <div className="rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--bg-card)' }}>
                <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.mcp.deleteTokenTitle')}</h3>
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.deleteTokenMessage')}</p>
                <div className="flex gap-2 justify-end">
                  <button onClick={() => setMcpDeleteId(null)}
                    className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                    {t('common.cancel')}
                  </button>
                  <button onClick={() => handleDeleteMcpToken(mcpDeleteId)}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700">
                    {t('settings.mcp.deleteTokenTitle')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Account */}
          <Section title={t('settings.account')} icon={User}>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.username')}</label>
              <input
                type="text"
                value={username}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUsername(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.email')}</label>
              <input
                type="email"
                value={email}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
              />
            </div>

            {/* Change Password */}
            {!oidcOnlyMode && (
            <div style={{ paddingTop: 16, marginTop: 16, borderTop: '1px solid var(--border-secondary)' }}>
              <label className="block text-sm font-medium text-slate-700 mb-3">{t('settings.changePassword')}</label>
              <div className="space-y-3">
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCurrentPassword(e.target.value)}
                  placeholder={t('settings.currentPassword')}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                />
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPassword(e.target.value)}
                  placeholder={t('settings.newPassword')}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmPassword(e.target.value)}
                  placeholder={t('settings.confirmPassword')}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                />
                <button
                  onClick={async () => {
                    if (!currentPassword) return toast.error(t('settings.currentPasswordRequired'))
                    if (!newPassword) return toast.error(t('settings.passwordRequired'))
                    if (newPassword.length < 8) return toast.error(t('settings.passwordTooShort'))
                    if (newPassword !== confirmPassword) return toast.error(t('settings.passwordMismatch'))
                    try {
                      await authApi.changePassword({ current_password: currentPassword, new_password: newPassword })
                      toast.success(t('settings.passwordChanged'))
                      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
                      await loadUser({ silent: true })
                    } catch (err: unknown) {
                      toast.error(getApiErrorMessage(err, t('common.error')))
                    }
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
                  onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => e.currentTarget.style.background = 'var(--bg-card)'}
                >
                  <Lock size={14} />
                  {t('settings.updatePassword')}
                </button>
              </div>
            </div>
            )}

            {/* MFA */}
            <div style={{ paddingTop: 16, marginTop: 16, borderTop: '1px solid var(--border-secondary)' }}>
              <div className="flex items-center gap-2 mb-3">
                <KeyRound className="w-5 h-5" style={{ color: 'var(--text-secondary)' }} />
                <h3 className="font-semibold text-base m-0" style={{ color: 'var(--text-primary)' }}>{t('settings.mfa.title')}</h3>
              </div>
              <div className="space-y-3">
                {mfaRequiredByPolicy && (
                  <div
                    className="flex gap-3 p-3 rounded-lg border text-sm"
                    style={{
                      background: 'var(--bg-secondary)',
                      borderColor: 'var(--border-primary)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <AlertTriangle className="w-5 h-5 flex-shrink-0 text-amber-600" />
                    <p className="m-0 leading-relaxed">{t('settings.mfa.requiredByPolicy')}</p>
                  </div>
                )}
                <p className="text-sm m-0" style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>{t('settings.mfa.description')}</p>
                {demoMode ? (
                  <p className="text-sm text-amber-700 m-0">{t('settings.mfa.demoBlocked')}</p>
                ) : (
                  <>
                    <p className="text-sm font-medium m-0" style={{ color: 'var(--text-secondary)' }}>
                      {user?.mfa_enabled ? t('settings.mfa.enabled') : t('settings.mfa.disabled')}
                    </p>

                    {!user?.mfa_enabled && !mfaQr && (
                      <button
                        type="button"
                        disabled={mfaLoading}
                        onClick={async () => {
                          setMfaLoading(true)
                          try {
                            const data = await authApi.mfaSetup() as { qr_data_url: string; secret: string }
                            setMfaQr(data.qr_data_url)
                            setMfaSecret(data.secret)
                            setMfaSetupCode('')
                          } catch (err: unknown) {
                            toast.error(getApiErrorMessage(err, t('common.error')))
                          } finally {
                            setMfaLoading(false)
                          }
                        }}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                        style={{ border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
                      >
                        {mfaLoading ? <div className="w-4 h-4 border-2 border-slate-300 border-t-slate-700 rounded-full animate-spin" /> : <KeyRound size={14} />}
                        {t('settings.mfa.setup')}
                      </button>
                    )}

                    {!user?.mfa_enabled && mfaQr && (
                      <div className="space-y-3">
                        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{t('settings.mfa.scanQr')}</p>
                        <img src={mfaQr} alt="" className="rounded-lg border mx-auto block" style={{ maxWidth: 200, borderColor: 'var(--border-primary)' }} />
                        <div>
                          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.mfa.secretLabel')}</label>
                          <code className="block text-xs p-2 rounded break-all" style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)' }}>{mfaSecret}</code>
                        </div>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={mfaSetupCode}
                          onChange={(e) => setMfaSetupCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                          placeholder={t('settings.mfa.codePlaceholder')}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                        />
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={mfaLoading || mfaSetupCode.length < 6}
                            onClick={async () => {
                              setMfaLoading(true)
                              try {
                                const resp = await authApi.mfaEnable({ code: mfaSetupCode }) as { backup_codes?: string[] }
                                toast.success(t('settings.mfa.toastEnabled'))
                                setMfaQr(null)
                                setMfaSecret(null)
                                setMfaSetupCode('')
                                const codes = resp.backup_codes || null
                                if (codes?.length) {
                                  try {
                                    sessionStorage.setItem(MFA_BACKUP_SESSION_KEY, JSON.stringify(codes))
                                  } catch {
                                    /* ignore quota / private mode */
                                  }
                                }
                                setBackupCodes(codes)
                                await loadUser({ silent: true })
                              } catch (err: unknown) {
                                toast.error(getApiErrorMessage(err, t('common.error')))
                              } finally {
                                setMfaLoading(false)
                              }
                            }}
                            className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:opacity-50"
                          >
                            {t('settings.mfa.enable')}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setMfaQr(null); setMfaSecret(null); setMfaSetupCode('') }}
                            className="px-4 py-2 rounded-lg text-sm border"
                            style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}
                          >
                            {t('settings.mfa.cancelSetup')}
                          </button>
                        </div>
                      </div>
                    )}

                    {user?.mfa_enabled && (
                      <div className="space-y-3">
                        <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('settings.mfa.disableTitle')}</p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('settings.mfa.disableHint')}</p>
                        <input
                          type="password"
                          value={mfaDisablePwd}
                          onChange={(e) => setMfaDisablePwd(e.target.value)}
                          placeholder={t('settings.currentPassword')}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                        />
                        <input
                          type="text"
                          inputMode="numeric"
                          value={mfaDisableCode}
                          onChange={(e) => setMfaDisableCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                          placeholder={t('settings.mfa.codePlaceholder')}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                        />
                        <button
                          type="button"
                          disabled={mfaLoading || !mfaDisablePwd || mfaDisableCode.length < 6}
                          onClick={async () => {
                            setMfaLoading(true)
                            try {
                              await authApi.mfaDisable({ password: mfaDisablePwd, code: mfaDisableCode })
                              toast.success(t('settings.mfa.toastDisabled'))
                              setMfaDisablePwd('')
                              setMfaDisableCode('')
                              sessionStorage.removeItem(MFA_BACKUP_SESSION_KEY)
                              setBackupCodes(null)
                              await loadUser({ silent: true })
                            } catch (err: unknown) {
                              toast.error(getApiErrorMessage(err, t('common.error')))
                            } finally {
                              setMfaLoading(false)
                            }
                          }}
                          className="px-4 py-2 rounded-lg text-sm font-medium text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-50"
                        >
                          {t('settings.mfa.disable')}
                        </button>
                      </div>
                    )}

                    {backupCodes && backupCodes.length > 0 && (
                      <div className="space-y-3 p-3 rounded-lg border" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-hover)' }}>
                        <p className="text-sm font-semibold m-0" style={{ color: 'var(--text-primary)' }}>{t('settings.mfa.backupTitle')}</p>
                        <p className="text-xs m-0" style={{ color: 'var(--text-muted)' }}>{t('settings.mfa.backupDescription')}</p>
                        <pre className="text-xs m-0 p-2 rounded border overflow-auto" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-primary)', maxHeight: 220 }}>{backupCodesText}</pre>
                        <p className="text-xs m-0" style={{ color: '#b45309' }}>{t('settings.mfa.backupWarning')}</p>
                        <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={copyBackupCodes} className="px-3 py-2 rounded-lg text-xs border flex items-center gap-1.5" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                            <Copy size={13} /> {t('settings.mfa.backupCopy')}
                          </button>
                          <button type="button" onClick={downloadBackupCodes} className="px-3 py-2 rounded-lg text-xs border flex items-center gap-1.5" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                            <Download size={13} /> {t('settings.mfa.backupDownload')}
                          </button>
                          <button type="button" onClick={printBackupCodes} className="px-3 py-2 rounded-lg text-xs border flex items-center gap-1.5" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                            <Printer size={13} /> {t('settings.mfa.backupPrint')}
                          </button>
                          <button type="button" onClick={dismissBackupCodes} className="px-3 py-2 rounded-lg text-xs border" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                            {t('common.ok')}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div style={{ position: 'relative', flexShrink: 0 }}>
                {user?.avatar_url ? (
                  <img src={user.avatar_url} alt="" style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover' }} />
                ) : (
                  <div style={{
                    width: 64, height: 64, borderRadius: '50%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 24, fontWeight: 700,
                    background: 'var(--bg-hover)', color: 'var(--text-secondary)',
                  }}>
                    {user?.username?.charAt(0).toUpperCase()}
                  </div>
                )}
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleAvatarUpload}
                  style={{ display: 'none' }}
                />
                <button
                  onClick={() => avatarInputRef.current?.click()}
                  style={{
                    position: 'absolute', bottom: -3, right: -3,
                    width: 28, height: 28, borderRadius: '50%',
                    background: 'var(--text-primary)', color: 'var(--bg-card)',
                    border: '2px solid var(--bg-card)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', padding: 0, transition: 'transform 0.15s, opacity 0.15s',
                  }}
                  onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.transform = 'scale(1.15)'; e.currentTarget.style.opacity = '0.85' }}
                  onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.opacity = '1' }}
                >
                  <Camera size={14} />
                </button>
                {user?.avatar_url && (
                  <button
                    onClick={handleAvatarRemove}
                    style={{
                      position: 'absolute', top: -2, right: -2,
                      width: 20, height: 20, borderRadius: '50%',
                      background: '#ef4444', color: 'white',
                      border: '2px solid var(--bg-card)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', padding: 0,
                    }}
                  >
                    <Trash2 size={10} />
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  <span className="font-medium" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)' }}>
                    {user?.role === 'admin' ? <><Shield size={13} /> {t('settings.roleAdmin')}</> : t('settings.roleUser')}
                  </span>
                  {(user as UserWithOidc)?.oidc_issuer && (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontSize: 10, fontWeight: 500, padding: '1px 8px', borderRadius: 99,
                      background: '#dbeafe', color: '#1d4ed8', marginLeft: 6,
                    }}>
                      SSO
                    </span>
                  )}
                </div>
                {(user as UserWithOidc)?.oidc_issuer && (
                  <p style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: -2 }}>
                    {t('settings.oidcLinked')} {(user as UserWithOidc).oidc_issuer!.replace('https://', '').replace(/\/+$/, '')}
                  </p>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <button
                onClick={saveProfile}
                disabled={saving.profile}
                className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:bg-slate-400"
              >
                {saving.profile ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
                {t('settings.saveProfile')}
              </button>
              <button
                onClick={async () => {
                  if (user?.role === 'admin') {
                    try {
                      const data = await adminApi.stats()
                      const adminUsers = (await adminApi.users()).users.filter((u: { role: string }) => u.role === 'admin')
                      if (adminUsers.length <= 1) {
                        setShowDeleteConfirm('blocked')
                        return
                      }
                    } catch {}
                  }
                  setShowDeleteConfirm(true)
                }}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors text-red-500 hover:bg-red-50"
                style={{ border: '1px solid #fecaca' }}
              >
                <Trash2 size={14} />
                {t('settings.deleteAccount')}
              </button>
            </div>
          </Section>

          {appVersion && (
            <Section title={t('settings.about')} icon={Info}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--bg-tertiary)', borderRadius: 99, padding: '6px 14px' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>TREK</span>
                  <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>v{appVersion}</span>
                </div>
                <a href="https://discord.gg/nSdKaXgN" target="_blank" rel="noopener noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 99, background: 'var(--bg-tertiary)', transition: 'background 0.15s' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#5865F220'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                  title="Discord">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="var(--text-faint)"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
                </a>
              </div>
            </Section>
          )}

          {/* Delete Account Confirmation */}
          {showDeleteConfirm === 'blocked' && (
            <div style={{
              position: 'fixed', inset: 0, zIndex: 9999,
              background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
            }} onClick={() => setShowDeleteConfirm(false)}>
              <div style={{
                background: 'var(--bg-card)', borderRadius: 16, padding: '28px 24px',
                maxWidth: 400, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
              }} onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Shield size={18} style={{ color: '#d97706' }} />
                  </div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{t('settings.deleteBlockedTitle')}</h3>
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 20px' }}>
                  {t('settings.deleteBlockedMessage')}
                </p>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    style={{
                      padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
                      border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-secondary)',
                      cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    {t('common.ok') || 'OK'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {showDeleteConfirm === true && (
            <div style={{
              position: 'fixed', inset: 0, zIndex: 9999,
              background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
            }} onClick={() => setShowDeleteConfirm(false)}>
              <div style={{
                background: 'var(--bg-card)', borderRadius: 16, padding: '28px 24px',
                maxWidth: 400, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
              }} onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Trash2 size={18} style={{ color: '#ef4444' }} />
                  </div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{t('settings.deleteAccountTitle')}</h3>
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 20px' }}>
                  {t('settings.deleteAccountWarning')}
                </p>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    style={{
                      padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
                      border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-secondary)',
                      cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        await authApi.deleteOwnAccount()
                        logout()
                        navigate('/login')
                      } catch (err: unknown) {
                        toast.error(getApiErrorMessage(err, t('common.error')))
                        setShowDeleteConfirm(false)
                      }
                    }}
                    style={{
                      padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                      border: 'none', background: '#ef4444', color: 'white',
                      cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    {t('settings.deleteAccountConfirm')}
                  </button>
                </div>
              </div>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  )
}
