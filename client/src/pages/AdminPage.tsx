import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import apiClient, { adminApi, authApi, notificationsApi } from '../api/client'
import DevNotificationsPanel from '../components/Admin/DevNotificationsPanel'
import { useAuthStore } from '../store/authStore'
import { useSettingsStore } from '../store/settingsStore'
import { useAddonStore } from '../store/addonStore'
import { useTranslation } from '../i18n'
import { getApiErrorMessage } from '../types'
import Navbar from '../components/Layout/Navbar'
import Modal from '../components/shared/Modal'
import { useToast } from '../components/shared/Toast'
import CategoryManager from '../components/Admin/CategoryManager'
import BackupPanel from '../components/Admin/BackupPanel'
import GitHubPanel from '../components/Admin/GitHubPanel'
import AddonManager from '../components/Admin/AddonManager'
import PackingTemplateManager from '../components/Admin/PackingTemplateManager'
import AuditLogPanel from '../components/Admin/AuditLogPanel'
import AdminMcpTokensPanel from '../components/Admin/AdminMcpTokensPanel'
import PermissionsPanel from '../components/Admin/PermissionsPanel'
import { Users, Map, Briefcase, Shield, Trash2, Edit2, FileText, Eye, EyeOff, Save, CheckCircle, XCircle, Loader2, UserPlus, ArrowUpCircle, ExternalLink, Download, Sun, Link2, Copy, Plus, RefreshCw, AlertTriangle } from 'lucide-react'
import CustomSelect from '../components/shared/CustomSelect'

interface AdminUser {
  id: number
  username: string
  email: string
  role: 'admin' | 'user'
  created_at: string
  last_login?: string | null
  online?: boolean
  oidc_issuer?: string | null
  avatar_url?: string | null
}

interface AdminStats {
  totalUsers: number
  totalTrips: number
  totalPlaces: number
  totalFiles: number
}

interface OidcConfig {
  issuer: string
  client_id: string
  client_secret: string
  client_secret_set: boolean
  display_name: string
  oidc_only: boolean
  discovery_url: string
}

interface UpdateInfo {
  update_available: boolean
  latest: string
  current: string
  release_url?: string
  is_docker?: boolean
}

const ADMIN_EVENT_LABEL_KEYS: Record<string, string> = {
  version_available: 'settings.notifyVersionAvailable',
}

const ADMIN_CHANNEL_LABEL_KEYS: Record<string, string> = {
  inapp: 'settings.notificationPreferences.inapp',
  email: 'settings.notificationPreferences.email',
  webhook: 'settings.notificationPreferences.webhook',
}

function AdminNotificationsPanel({ t, toast }: { t: (k: string) => string; toast: ReturnType<typeof useToast> }) {
  const [matrix, setMatrix] = useState<any>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    adminApi.getNotificationPreferences().then((data: any) => setMatrix(data)).catch(() => {})
  }, [])

  if (!matrix) return <p style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic', padding: 16 }}>Loading…</p>

  const visibleChannels = (['inapp', 'email', 'webhook'] as const).filter(ch => {
    if (!matrix.available_channels[ch]) return false
    return matrix.event_types.some((evt: string) => matrix.implemented_combos[evt]?.includes(ch))
  })

  const toggle = async (eventType: string, channel: string) => {
    const current = matrix.preferences[eventType]?.[channel] ?? true
    const updated = { ...matrix.preferences, [eventType]: { ...matrix.preferences[eventType], [channel]: !current } }
    setMatrix((m: any) => m ? { ...m, preferences: updated } : m)
    setSaving(true)
    try {
      await adminApi.updateNotificationPreferences(updated)
    } catch {
      setMatrix((m: any) => m ? { ...m, preferences: matrix.preferences } : m)
      toast.error(t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  if (matrix.event_types.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <p style={{ fontSize: 13, color: 'var(--text-faint)' }}>{t('settings.notificationPreferences.noChannels')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">{t('admin.tabs.notifications')}</h2>
          <p className="text-xs text-slate-400 mt-1">{t('admin.notifications.adminNotificationsHint')}</p>
        </div>
        <div className="p-6">
          {saving && <p style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 8 }}>Saving…</p>}
          {/* Header row */}
          <div style={{ display: 'grid', gridTemplateColumns: `1fr ${visibleChannels.map(() => '80px').join(' ')}`, gap: 4, paddingBottom: 6, marginBottom: 4, borderBottom: '1px solid var(--border-primary)' }}>
            <span />
            {visibleChannels.map(ch => (
              <span key={ch} style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {t(ADMIN_CHANNEL_LABEL_KEYS[ch]) || ch}
              </span>
            ))}
          </div>
          {/* Event rows */}
          {matrix.event_types.map((eventType: string) => {
            const implementedForEvent = matrix.implemented_combos[eventType] ?? []
            return (
              <div key={eventType} style={{ display: 'grid', gridTemplateColumns: `1fr ${visibleChannels.map(() => '80px').join(' ')}`, gap: 4, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border-primary)' }}>
                <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                  {t(ADMIN_EVENT_LABEL_KEYS[eventType]) || eventType}
                </span>
                {visibleChannels.map(ch => {
                  if (!implementedForEvent.includes(ch)) {
                    return <span key={ch} style={{ textAlign: 'center', color: 'var(--text-faint)', fontSize: 14 }}>—</span>
                  }
                  const isOn = matrix.preferences[eventType]?.[ch] ?? true
                  return (
                    <div key={ch} style={{ display: 'flex', justifyContent: 'center' }}>
                      <button
                        onClick={() => toggle(eventType, ch)}
                        className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0"
                        style={{ background: isOn ? 'var(--text-primary)' : 'var(--border-primary)' }}
                      >
                        <span className="absolute left-0.5 h-4 w-4 rounded-full bg-white transition-transform duration-200"
                          style={{ transform: isOn ? 'translateX(16px)' : 'translateX(0)' }} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default function AdminPage(): React.ReactElement {
  const { demoMode, serverTimezone } = useAuthStore()
  const { t, locale } = useTranslation()
  const hour12 = useSettingsStore(s => s.settings.time_format) === '12h'
  const mcpEnabled = useAddonStore(s => s.isEnabled('mcp'))
  const devMode = useAuthStore(s => s.devMode)
  const TABS = [
    { id: 'users', label: t('admin.tabs.users') },
    { id: 'config', label: t('admin.tabs.config') },
    { id: 'addons', label: t('admin.tabs.addons') },
    { id: 'settings', label: t('admin.tabs.settings') },
    { id: 'notifications', label: t('admin.tabs.notifications') },
    { id: 'backup', label: t('admin.tabs.backup') },
    { id: 'audit', label: t('admin.tabs.audit') },
    ...(mcpEnabled ? [{ id: 'mcp-tokens', label: t('admin.tabs.mcpTokens') }] : []),
    { id: 'github', label: t('admin.tabs.github') },
    ...(devMode ? [{ id: 'dev-notifications', label: 'Dev: Notifications' }] : []),
  ]

  const [activeTab, setActiveTab] = useState<string>('users')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null)
  const [editForm, setEditForm] = useState<{ username: string; email: string; role: string; password: string }>({ username: '', email: '', role: 'user', password: '' })
  const [showCreateUser, setShowCreateUser] = useState<boolean>(false)
  const [createForm, setCreateForm] = useState<{ username: string; email: string; password: string; role: string }>({ username: '', email: '', password: '', role: 'user' })

  // Bag tracking
  const [bagTrackingEnabled, setBagTrackingEnabled] = useState<boolean>(false)
  useEffect(() => { adminApi.getBagTracking().then(d => setBagTrackingEnabled(d.enabled)).catch(() => {}) }, [])

  // OIDC config
  const [oidcConfig, setOidcConfig] = useState<OidcConfig>({ issuer: '', client_id: '', client_secret: '', client_secret_set: false, display_name: '', oidc_only: false, discovery_url: '' })
  const [savingOidc, setSavingOidc] = useState<boolean>(false)

  // Registration toggle
  const [allowRegistration, setAllowRegistration] = useState<boolean>(true)
  const [requireMfa, setRequireMfa] = useState<boolean>(false)

  // Invite links
  const [invites, setInvites] = useState<any[]>([])
  const [showCreateInvite, setShowCreateInvite] = useState<boolean>(false)
  const [inviteForm, setInviteForm] = useState<{ max_uses: number; expires_in_days: number | '' }>({ max_uses: 1, expires_in_days: 7 })

  // File types
  const [allowedFileTypes, setAllowedFileTypes] = useState<string>('jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv')
  const [savingFileTypes, setSavingFileTypes] = useState<boolean>(false)

  // SMTP settings
  const [smtpValues, setSmtpValues] = useState<Record<string, string>>({})
  const [smtpLoaded, setSmtpLoaded] = useState(false)
  useEffect(() => {
    apiClient.get('/auth/app-settings').then(r => {
      setSmtpValues(r.data || {})
      setSmtpLoaded(true)
    }).catch(() => setSmtpLoaded(true))
  }, [])

  // API Keys
  const [mapsKey, setMapsKey] = useState<string>('')
  const [weatherKey, setWeatherKey] = useState<string>('')
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})
  const [savingKeys, setSavingKeys] = useState<boolean>(false)
  const [validating, setValidating] = useState<Record<string, boolean>>({})
  const [validation, setValidation] = useState<Record<string, boolean | undefined>>({})

  // Version check & update
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [showUpdateModal, setShowUpdateModal] = useState<boolean>(false)

  const { user: currentUser, updateApiKeys, setAppRequireMfa, setTripRemindersEnabled, logout } = useAuthStore()
  const navigate = useNavigate()
  const toast = useToast()

  const [showRotateJwtModal, setShowRotateJwtModal] = useState<boolean>(false)
  const [rotatingJwt, setRotatingJwt] = useState<boolean>(false)

  useEffect(() => {
    loadData()
    loadAppConfig()
    loadApiKeys()
    adminApi.getOidc().then(setOidcConfig).catch(() => {})
    adminApi.checkVersion().then(data => {
      if (data.update_available) setUpdateInfo(data)
    }).catch(() => {})
  }, [])

  const loadData = async () => {
    setIsLoading(true)
    try {
      const [usersData, statsData, invitesData] = await Promise.all([
        adminApi.users(),
        adminApi.stats(),
        adminApi.listInvites().catch(() => ({ invites: [] })),
      ])
      setUsers(usersData.users)
      setStats(statsData)
      setInvites(invitesData.invites || [])
    } catch (err: unknown) {
      toast.error(t('admin.toast.loadError'))
    } finally {
      setIsLoading(false)
    }
  }

  const loadAppConfig = async () => {
    try {
      const config = await authApi.getAppConfig()
      setAllowRegistration(config.allow_registration)
      if (config.require_mfa !== undefined) setRequireMfa(!!config.require_mfa)
      if (config.allowed_file_types) setAllowedFileTypes(config.allowed_file_types)
    } catch (err: unknown) {
      // ignore
    }
  }

  const loadApiKeys = async () => {
    try {
      const data = await authApi.getSettings()
      setMapsKey(data.settings?.maps_api_key || '')
      setWeatherKey(data.settings?.openweather_api_key || '')
    } catch (err: unknown) {
      // ignore
    }
  }

  const handleToggleRegistration = async (value) => {
    setAllowRegistration(value)
    try {
      await authApi.updateAppSettings({ allow_registration: value })
    } catch (err: unknown) {
      setAllowRegistration(!value)
      toast.error(getApiErrorMessage(err, t('common.error')))
    }
  }

  const handleToggleRequireMfa = async (value: boolean) => {
    setRequireMfa(value)
    try {
      await authApi.updateAppSettings({ require_mfa: value })
      setAppRequireMfa(value)
      toast.success(t('common.saved'))
    } catch (err: unknown) {
      setRequireMfa(!value)
      toast.error(getApiErrorMessage(err, t('common.error')))
    }
  }

  const toggleKey = (key) => {
    setShowKeys(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleSaveApiKeys = async () => {
    setSavingKeys(true)
    try {
      await updateApiKeys({
        maps_api_key: mapsKey,
        openweather_api_key: weatherKey,
      })
      toast.success(t('admin.keySaved'))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setSavingKeys(false)
    }
  }

  const handleValidateKeys = async () => {
    setValidating({ maps: true, weather: true })
    try {
      // Save first so validation uses the current values
      await updateApiKeys({ maps_api_key: mapsKey, openweather_api_key: weatherKey })
      const result = await authApi.validateKeys()
      setValidation(result)
    } catch (err: unknown) {
      toast.error(t('common.error'))
    } finally {
      setValidating({})
    }
  }

  const handleValidateKey = async (keyType) => {
    setValidating(prev => ({ ...prev, [keyType]: true }))
    try {
      // Save first so validation uses the current values
      await updateApiKeys({ maps_api_key: mapsKey, openweather_api_key: weatherKey })
      const result = await authApi.validateKeys()
      setValidation(prev => ({ ...prev, [keyType]: result[keyType] }))
    } catch (err: unknown) {
      toast.error(t('common.error'))
    } finally {
      setValidating(prev => ({ ...prev, [keyType]: false }))
    }
  }

  const handleCreateUser = async () => {
    if (!createForm.username.trim() || !createForm.email.trim() || !createForm.password.trim()) {
      toast.error(t('admin.toast.fieldsRequired'))
      return
    }
    if (createForm.password.trim().length < 8) {
      toast.error(t('settings.passwordTooShort'))
      return
    }
    try {
      const data = await adminApi.createUser(createForm)
      setUsers(prev => [data.user, ...prev])
      setShowCreateUser(false)
      setCreateForm({ username: '', email: '', password: '', role: 'user' })
      toast.success(t('admin.toast.userCreated'))
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('admin.toast.createError')))
    }
  }

  const handleCreateInvite = async () => {
    try {
      const data = await adminApi.createInvite({
        max_uses: inviteForm.max_uses,
        expires_in_days: inviteForm.expires_in_days || undefined,
      })
      setInvites(prev => [data.invite, ...prev])
      setShowCreateInvite(false)
      setInviteForm({ max_uses: 1, expires_in_days: 7 })
      // Copy link to clipboard
      const link = `${window.location.origin}/register?invite=${data.invite.token}`
      navigator.clipboard.writeText(link).then(() => toast.success(t('admin.invite.copied')))
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('admin.invite.createError')))
    }
  }

  const handleDeleteInvite = async (id: number) => {
    try {
      await adminApi.deleteInvite(id)
      setInvites(prev => prev.filter(i => i.id !== id))
      toast.success(t('admin.invite.deleted'))
    } catch {
      toast.error(t('admin.invite.deleteError'))
    }
  }

  const copyInviteLink = (token: string) => {
    const link = `${window.location.origin}/register?invite=${token}`
    navigator.clipboard.writeText(link).then(() => toast.success(t('admin.invite.copied')))
  }

  const handleEditUser = (user) => {
    setEditingUser(user)
    setEditForm({ username: user.username, email: user.email, role: user.role, password: '' })
  }

  const handleSaveUser = async () => {
    try {
      const payload: { username?: string; email?: string; role: string; password?: string } = {
        username: editForm.username.trim() || undefined,
        email: editForm.email.trim() || undefined,
        role: editForm.role,
      }
      if (editForm.password.trim()) {
        if (editForm.password.trim().length < 8) {
          toast.error(t('settings.passwordTooShort'))
          return
        }
        payload.password = editForm.password.trim()
      }
      const data = await adminApi.updateUser(editingUser.id, payload)
      setUsers(prev => prev.map(u => u.id === editingUser.id ? data.user : u))
      setEditingUser(null)
      toast.success(t('admin.toast.userUpdated'))
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('admin.toast.updateError')))
    }
  }

  const handleDeleteUser = async (user) => {
    if (user.id === currentUser?.id) {
      toast.error(t('admin.toast.cannotDeleteSelf'))
      return
    }
    if (!confirm(t('admin.deleteUser', { name: user.username }))) return
    try {
      await adminApi.deleteUser(user.id)
      setUsers(prev => prev.filter(u => u.id !== user.id))
      toast.success(t('admin.toast.userDeleted'))
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('admin.toast.deleteError')))
    }
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-secondary)' }}>
      <Navbar />

      <div style={{ paddingTop: 'var(--nav-h)' }}>
        <div className="max-w-6xl mx-auto px-4 py-8">
          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center">
              <Shield className="w-5 h-5 text-slate-700" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">{t('admin.title')}</h1>
              <p className="text-slate-500 text-sm">{t('admin.subtitle')}</p>
            </div>
          </div>

          {/* Update Banner */}
          {updateInfo && (
            <div className="mb-6 p-4 rounded-xl border flex flex-col sm:flex-row items-start sm:items-center gap-4 bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700">
              <div className="flex items-center gap-4 flex-1 min-w-0">
                <div className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center bg-amber-500 dark:bg-amber-600">
                  <ArrowUpCircle className="w-5 h-5 text-white" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">{t('admin.update.available')}</p>
                  <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                    {t('admin.update.text').replace('{version}', `v${updateInfo.latest}`).replace('{current}', `v${updateInfo.current}`)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {updateInfo.release_url && (
                  <a
                    href={updateInfo.release_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-600 hover:bg-amber-100 dark:hover:bg-amber-900/50"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    {t('admin.update.button')}
                  </a>
                )}
                <button
                  onClick={() => setShowUpdateModal(true)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-colors bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-gray-200"
                >
                  <Download className="w-4 h-4" />
                  {t('admin.update.howTo')}
                </button>
              </div>
            </div>
          )}

          {/* Demo Baseline Button */}
          {demoMode && (
            <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-amber-900">Demo Baseline</p>
                <p className="text-xs text-amber-700">Save current state as the hourly reset point. All admin trips and settings will be preserved.</p>
              </div>
              <button
                onClick={async () => {
                  try {
                    await adminApi.saveDemoBaseline()
                    toast.success('Baseline saved! Resets will restore to this state.')
                  } catch (e) {
                    toast.error(e.response?.data?.error || 'Failed to save baseline')
                  }
                }}
                className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-semibold hover:bg-amber-700 transition-colors flex-shrink-0 ml-4"
              >
                Save Baseline
              </button>
            </div>
          )}

          {/* Stats */}
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
              {[
                { label: t('admin.stats.users'), value: stats.totalUsers, icon: Users },
                { label: t('admin.stats.trips'), value: stats.totalTrips, icon: Briefcase },
                { label: t('admin.stats.places'), value: stats.totalPlaces, icon: Map },
                { label: t('admin.stats.files'), value: stats.totalFiles || 0, icon: FileText },
              ].map(({ label, value, icon: Icon }) => (
                <div key={label} className="rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
                  <div className="flex items-center gap-4">
                    <Icon className="w-5 h-5" style={{ color: 'var(--text-primary)' }} />
                    <div>
                      <p className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{value}</p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Tabs */}
          <div className="grid grid-cols-3 sm:flex gap-1 mb-6 rounded-xl p-1" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 sm:px-4 py-2 text-xs sm:text-sm font-medium rounded-lg transition-colors ${
                  activeTab === tab.id
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          {activeTab === 'users' && (
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="p-5 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-slate-900">{t('admin.tabs.users')}</h2>
                  <p className="text-xs text-slate-400 mt-1">{users.length} {t('admin.stats.users')}</p>
                </div>
                <button
                  onClick={() => setShowCreateUser(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700 transition-colors"
                >
                  <UserPlus className="w-4 h-4" />
                  {t('admin.createUser')}
                </button>
              </div>

              {isLoading ? (
                <div className="p-8 text-center">
                  <div className="w-8 h-8 border-2 border-slate-200 border-t-slate-900 rounded-full animate-spin mx-auto"></div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-slate-100 bg-slate-50">
                        <th className="px-5 py-3">{t('admin.table.user')}</th>
                        <th className="px-5 py-3">{t('admin.table.email')}</th>
                        <th className="px-5 py-3">{t('admin.table.role')}</th>
                        <th className="px-5 py-3">{t('admin.table.created')}</th>
                        <th className="px-5 py-3">{t('admin.table.lastLogin')}</th>
                        <th className="px-5 py-3 text-right">{t('admin.table.actions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {users.map(u => (
                        <tr key={u.id} className={`hover:bg-slate-50 transition-colors ${u.id === currentUser?.id ? 'bg-slate-50/60' : ''}`}>
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <div className="relative">
                                {u.avatar_url ? (
                                  <img src={u.avatar_url} alt={u.username} className="w-8 h-8 rounded-full object-cover" />
                                ) : (
                                  <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-sm font-medium text-slate-700">
                                    {u.username.charAt(0).toUpperCase()}
                                  </div>
                                )}
                                <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2" style={{ borderColor: 'var(--bg-card)', background: u.online ? '#22c55e' : '#94a3b8' }} />
                              </div>
                              <div>
                                <p className="text-sm font-medium text-slate-900">{u.username}</p>
                                {u.id === currentUser?.id && (
                                  <span className="text-xs text-slate-500">{t('admin.you')}</span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-3 text-sm text-slate-600">{u.email}</td>
                          <td className="px-5 py-3">
                            <span className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-0.5 rounded-full ${
                              u.role === 'admin'
                                ? 'bg-slate-900 text-white'
                                : 'bg-slate-100 text-slate-600'
                            }`}>
                              {u.role === 'admin' && <Shield className="w-3 h-3" />}
                              {u.role === 'admin' ? t('settings.roleAdmin') : t('settings.roleUser')}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-sm text-slate-500">
                            {new Date(u.created_at).toLocaleDateString(locale, { timeZone: serverTimezone })}
                          </td>
                          <td className="px-5 py-3 text-sm text-slate-500">
                            {u.last_login ? new Date(u.last_login).toLocaleDateString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12, timeZone: serverTimezone }) : '—'}
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2 justify-end">
                              <button
                                onClick={() => handleEditUser(u)}
                                className="p-1.5 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
                                title={t('admin.editUser')}
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleDeleteUser(u)}
                                disabled={u.id === currentUser?.id}
                                className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                title={t('admin.deleteUserTitle')}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Invite Links (inside users tab) */}
          {activeTab === 'users' && (
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden mt-6">
              <div className="p-5 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-slate-900">{t('admin.invite.title')}</h2>
                  <p className="text-xs text-slate-400 mt-1">{t('admin.invite.subtitle')}</p>
                </div>
                <button
                  onClick={() => setShowCreateInvite(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  {t('admin.invite.create')}
                </button>
              </div>

              {invites.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-400">{t('admin.invite.empty')}</div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {invites.map(inv => {
                    const isExpired = inv.expires_at && new Date(inv.expires_at) < new Date()
                    const isUsedUp = inv.max_uses > 0 && inv.used_count >= inv.max_uses
                    const isActive = !isExpired && !isUsedUp
                    return (
                      <div key={inv.id} className="px-5 py-3 flex items-center gap-4">
                        <Link2 className="w-4 h-4 flex-shrink-0" style={{ color: isActive ? 'var(--text-primary)' : '#d1d5db' }} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <code className="text-xs font-mono text-slate-600 truncate">{inv.token.slice(0, 12)}...</code>
                            <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                              isActive ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-400'
                            }`}>
                              {isUsedUp ? t('admin.invite.usedUp') : isExpired ? t('admin.invite.expired') : t('admin.invite.active')}
                            </span>
                          </div>
                          <div className="text-xs text-slate-400 mt-0.5">
                            {inv.used_count}/{inv.max_uses === 0 ? '∞' : inv.max_uses} {t('admin.invite.uses')}
                            {inv.expires_at && ` · ${t('admin.invite.expiresAt')} ${new Date(inv.expires_at).toLocaleDateString(locale, { timeZone: serverTimezone })}`}
                            {` · ${t('admin.invite.createdBy')} ${inv.created_by_name}`}
                          </div>
                        </div>
                        {isActive && (
                          <button onClick={() => copyInviteLink(inv.token)} title={t('admin.invite.copyLink')}
                            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors">
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button onClick={() => handleDeleteInvite(inv.id)} title={t('common.delete')}
                          className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'users' && <div className="mt-6"><PermissionsPanel /></div>}

          {/* Create Invite Modal */}
          <Modal isOpen={showCreateInvite} onClose={() => setShowCreateInvite(false)} title={t('admin.invite.create')} size="sm">
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">{t('admin.invite.maxUses')}</label>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5, 0].map(n => (
                    <button key={n} type="button" onClick={() => setInviteForm(f => ({ ...f, max_uses: n }))}
                      className={`flex-1 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                        inviteForm.max_uses === n ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                      }`}>
                      {n === 0 ? '∞' : `${n}×`}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">{t('admin.invite.expiry')}</label>
                <div className="flex gap-2">
                  {[
                    { value: 1, label: '1d' },
                    { value: 3, label: '3d' },
                    { value: 7, label: '7d' },
                    { value: 14, label: '14d' },
                    { value: '', label: '∞' },
                  ].map(opt => (
                    <button key={String(opt.value)} type="button" onClick={() => setInviteForm(f => ({ ...f, expires_in_days: opt.value as number | '' }))}
                      className={`flex-1 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                        inviteForm.expires_in_days === opt.value ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                      }`}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button onClick={() => setShowCreateInvite(false)} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700">{t('common.cancel')}</button>
                <button onClick={handleCreateInvite} className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700">{t('admin.invite.createAndCopy')}</button>
              </div>
            </div>
          </Modal>

          {activeTab === 'config' && (
            <div className="space-y-6">
              <PackingTemplateManager />
              <CategoryManager />
            </div>
          )}

          {activeTab === 'addons' && (
            <div className="space-y-6">
              <AddonManager bagTrackingEnabled={bagTrackingEnabled} onToggleBagTracking={async () => {
                const next = !bagTrackingEnabled
                setBagTrackingEnabled(next)
                try { await adminApi.updateBagTracking(next) } catch { setBagTrackingEnabled(!next) }
              }} />
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-6">
              {/* Registration Toggle */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100">
                  <h2 className="font-semibold text-slate-900">{t('admin.allowRegistration')}</h2>
                </div>
                <div className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-700">{t('admin.allowRegistration')}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{t('admin.allowRegistrationHint')}</p>
                    </div>
                    <button
                      onClick={() => handleToggleRegistration(!allowRegistration)}
                      className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
                      style={{ background: allowRegistration ? 'var(--text-primary)' : 'var(--border-primary)' }}
                    >
                      <span
                        className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                        style={{ transform: allowRegistration ? 'translateX(20px)' : 'translateX(0)' }}
                      />
                    </button>
                  </div>
                </div>
              </div>

              {/* Require 2FA for all users */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100">
                  <h2 className="font-semibold text-slate-900">{t('admin.requireMfa')}</h2>
                </div>
                <div className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-700">{t('admin.requireMfa')}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{t('admin.requireMfaHint')}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleToggleRequireMfa(!requireMfa)}
                      className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
                      style={{ background: requireMfa ? 'var(--text-primary)' : 'var(--border-primary)' }}
                    >
                      <span
                        className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                        style={{ transform: requireMfa ? 'translateX(20px)' : 'translateX(0)' }}
                      />
                    </button>
                  </div>
                </div>
              </div>

              {/* Allowed File Types */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100">
                  <h2 className="font-semibold text-slate-900">{t('admin.fileTypes')}</h2>
                  <p className="text-xs text-slate-400 mt-1">{t('admin.fileTypesHint')}</p>
                </div>
                <div className="p-6">
                  <input
                    type="text"
                    value={allowedFileTypes}
                    onChange={e => setAllowedFileTypes(e.target.value)}
                    placeholder="jpg,png,pdf,doc,docx,xls,xlsx,txt,csv"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                  />
                  <p className="text-xs text-slate-400 mt-2">{t('admin.fileTypesFormat')}</p>
                  <button
                    onClick={async () => {
                      setSavingFileTypes(true)
                      try {
                        await authApi.updateAppSettings({ allowed_file_types: allowedFileTypes })
                        toast.success(t('admin.fileTypesSaved'))
                      } catch { toast.error(t('common.error')) }
                      finally { setSavingFileTypes(false) }
                    }}
                    disabled={savingFileTypes}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:bg-slate-400 mt-3"
                  >
                    {savingFileTypes ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
                    {t('common.save')}
                  </button>
                </div>
              </div>

              {/* API Keys */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100">
                  <h2 className="font-semibold text-slate-900">{t('admin.apiKeys')}</h2>
                  <p className="text-xs text-slate-400 mt-1">{t('admin.apiKeysHint')}</p>
                </div>
                <div className="p-6 space-y-4">
                  {/* Google Maps Key */}
                  <div>
                    <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-1.5">
                      {t('admin.mapsKey')}
                      <span className="text-[9px] font-medium px-1.5 py-px rounded-full bg-emerald-200 dark:bg-emerald-800 text-emerald-800 dark:text-emerald-200">{t('admin.recommended')}</span>
                    </label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <input
                          type={showKeys.maps ? 'text' : 'password'}
                          value={mapsKey}
                          onChange={e => setMapsKey(e.target.value)}
                          placeholder={t('settings.keyPlaceholder')}
                          className="w-full pr-10 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                        />
                        <button
                          type="button"
                          onClick={() => toggleKey('maps')}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          {showKeys.maps ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      <button
                        onClick={() => handleValidateKey('maps')}
                        disabled={!mapsKey || validating.maps}
                        className="px-3 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                      >
                        {validating.maps ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : validation.maps === true ? (
                          <CheckCircle className="w-4 h-4 text-emerald-500" />
                        ) : validation.maps === false ? (
                          <XCircle className="w-4 h-4 text-red-500" />
                        ) : null}
                        {t('admin.validateKey')}
                      </button>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">{t('admin.mapsKeyHintLong')}</p>
                    {validation.maps === true && (
                      <p className="text-xs text-emerald-600 mt-1 flex items-center gap-1">
                        <span className="w-2 h-2 bg-emerald-500 rounded-full inline-block"></span>
                        {t('admin.keyValid')}
                      </p>
                    )}
                    {validation.maps === false && (
                      <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                        <span className="w-2 h-2 bg-red-500 rounded-full inline-block"></span>
                        {t('admin.keyInvalid')}
                      </p>
                    )}
                  </div>

                  {/* Open-Meteo Weather Info */}
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800 overflow-hidden">
                    <div className="px-4 py-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg bg-emerald-500 flex items-center justify-center flex-shrink-0">
                          <Sun className="w-3.5 h-3.5 text-white" />
                        </div>
                        <span className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">{t('admin.weather.title')}</span>
                      </div>
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-200 dark:bg-emerald-800 text-emerald-800 dark:text-emerald-200">{t('admin.weather.badge')}</span>
                    </div>
                    <div className="px-4 pb-3">
                      <p className="text-xs text-emerald-800 dark:text-emerald-300 leading-relaxed">{t('admin.weather.description')}</p>
                      <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1.5 leading-relaxed">{t('admin.weather.locationHint')}</p>
                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <div className="rounded-md bg-white dark:bg-emerald-900/40 px-3 py-2 border border-emerald-100 dark:border-emerald-800">
                          <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">{t('admin.weather.forecast')}</p>
                          <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5">{t('admin.weather.forecastDesc')}</p>
                        </div>
                        <div className="rounded-md bg-white dark:bg-emerald-900/40 px-3 py-2 border border-emerald-100 dark:border-emerald-800">
                          <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">{t('admin.weather.climate')}</p>
                          <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5">{t('admin.weather.climateDesc')}</p>
                        </div>
                        <div className="rounded-md bg-white dark:bg-emerald-900/40 px-3 py-2 border border-emerald-100 dark:border-emerald-800">
                          <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">{t('admin.weather.requests')}</p>
                          <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5">{t('admin.weather.requestsDesc')}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={handleSaveApiKeys}
                    disabled={savingKeys}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:bg-slate-400"
                  >
                    {savingKeys ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
                    {t('common.save')}
                  </button>
                </div>
              </div>

              {/* OIDC / SSO Configuration */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100">
                  <h2 className="font-semibold text-slate-900">{t('admin.oidcTitle')}</h2>
                  <p className="text-xs text-slate-400 mt-1">{t('admin.oidcSubtitle')}</p>
                </div>
                <div className="p-6 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('admin.oidcDisplayName')}</label>
                    <input
                      type="text"
                      value={oidcConfig.display_name}
                      onChange={e => setOidcConfig(c => ({ ...c, display_name: e.target.value }))}
                      placeholder='z.B. Google, Authentik, Keycloak'
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('admin.oidcIssuer')}</label>
                    <input
                      type="url"
                      value={oidcConfig.issuer}
                      onChange={e => setOidcConfig(c => ({ ...c, issuer: e.target.value }))}
                      placeholder='https://accounts.google.com'
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                    />
                    <p className="text-xs text-slate-400 mt-1">{t('admin.oidcIssuerHint')}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Discovery URL <span className="text-slate-400 font-normal">(optional)</span></label>
                    <input
                      type="url"
                      value={oidcConfig.discovery_url}
                      onChange={e => setOidcConfig(c => ({ ...c, discovery_url: e.target.value }))}
                      placeholder='https://auth.example.com/application/o/trek/.well-known/openid-configuration'
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                    />
                    <p className="text-xs text-slate-400 mt-1">Override the auto-constructed discovery URL. Required for providers like Authentik where the endpoint is not at <code className="bg-slate-100 px-1 rounded">{'<issuer>/.well-known/openid-configuration'}</code>.</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Client ID</label>
                    <input
                      type="text"
                      value={oidcConfig.client_id}
                      onChange={e => setOidcConfig(c => ({ ...c, client_id: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Client Secret</label>
                    <input
                      type="password"
                      value={oidcConfig.client_secret}
                      onChange={e => setOidcConfig(c => ({ ...c, client_secret: e.target.value }))}
                      placeholder={oidcConfig.client_secret_set ? '••••••••' : ''}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                    />
                  </div>
                  {/* OIDC-only mode toggle */}
                  <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                    <div>
                      <p className="text-sm font-medium text-slate-700">{t('admin.oidcOnlyMode')}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{t('admin.oidcOnlyModeHint')}</p>
                    </div>
                    <button
                      onClick={() => setOidcConfig(c => ({ ...c, oidc_only: !c.oidc_only }))}
                      className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ml-4"
                      style={{ background: oidcConfig.oidc_only ? 'var(--text-primary)' : 'var(--border-primary)' }}
                    >
                      <span
                        className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                        style={{ transform: oidcConfig.oidc_only ? 'translateX(20px)' : 'translateX(0)' }}
                      />
                    </button>
                  </div>

                  <button
                    onClick={async () => {
                      setSavingOidc(true)
                      try {
                        const payload: Record<string, unknown> = { issuer: oidcConfig.issuer, client_id: oidcConfig.client_id, display_name: oidcConfig.display_name, oidc_only: oidcConfig.oidc_only, discovery_url: oidcConfig.discovery_url }
                        if (oidcConfig.client_secret) payload.client_secret = oidcConfig.client_secret
                        await adminApi.updateOidc(payload)
                        toast.success(t('admin.oidcSaved'))
                      } catch (err: unknown) {
                        toast.error(getApiErrorMessage(err, t('common.error')))
                      } finally {
                        setSavingOidc(false)
                      }
                    }}
                    disabled={savingOidc}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:bg-slate-400"
                  >
                    {savingOidc ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
                    {t('common.save')}
                  </button>
                </div>
              </div>
              {/* Danger Zone */}
              <div className="bg-white rounded-xl border border-red-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-red-100 bg-red-50">
                  <h2 className="font-semibold text-red-700 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    Danger Zone
                  </h2>
                </div>
                <div className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-700">Rotate JWT Secret</p>
                      <p className="text-xs text-slate-400 mt-0.5">Generate a new JWT signing secret. All active sessions will be invalidated immediately.</p>
                    </div>
                    <button
                      onClick={() => setShowRotateJwtModal(true)}
                      className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Rotate
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'notifications' && (() => {
            // Derive active channels from smtpValues.notification_channels (plural)
            // with fallback to notification_channel (singular) for existing installs
            const rawChannels = smtpValues.notification_channels ?? smtpValues.notification_channel ?? 'none'
            const activeChans = rawChannels === 'none' ? [] : rawChannels.split(',').map((c: string) => c.trim())
            const emailActive = activeChans.includes('email')
            const webhookActive = activeChans.includes('webhook')

            const setChannels = async (email: boolean, webhook: boolean) => {
              const chans = [email && 'email', webhook && 'webhook'].filter(Boolean).join(',') || 'none'
              setSmtpValues(prev => ({ ...prev, notification_channels: chans }))
              try {
                await authApi.updateAppSettings({ notification_channels: chans })
              } catch {
                // Revert state on failure
                const reverted = [emailActive && 'email', webhookActive && 'webhook'].filter(Boolean).join(',') || 'none'
                setSmtpValues(prev => ({ ...prev, notification_channels: reverted }))
                toast.error(t('common.error'))
              }
            }

            const smtpConfigured = !!(smtpValues.smtp_host?.trim())
            const saveNotifications = async () => {
              // Saves credentials only — channel activation is auto-saved by the toggle
              const notifKeys = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_skip_tls_verify']
              const payload: Record<string, string> = {}
              for (const k of notifKeys) { if (smtpValues[k] !== undefined) payload[k] = smtpValues[k] }
              try {
                await authApi.updateAppSettings(payload)
                toast.success(t('admin.notifications.saved'))
                authApi.getAppConfig().then((c: { trip_reminders_enabled?: boolean }) => {
                  if (c?.trip_reminders_enabled !== undefined) setTripRemindersEnabled(c.trip_reminders_enabled)
                }).catch(() => {})
              } catch { toast.error(t('common.error')) }
            }

            return (<>
              <div className="space-y-4">
                {/* Email Panel */}
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                    <div>
                      <h2 className="font-semibold text-slate-900">{t('admin.notifications.emailPanel.title')}</h2>
                      <p className="text-xs text-slate-400 mt-1">{t('admin.smtp.hint')}</p>
                    </div>
                    <button
                      onClick={() => setChannels(!emailActive, webhookActive)}
                      className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0"
                      style={{ background: emailActive ? 'var(--text-primary)' : 'var(--border-primary)' }}
                    >
                      <span className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                        style={{ transform: emailActive ? 'translateX(20px)' : 'translateX(0)' }} />
                    </button>
                  </div>
                  <div className={`p-6 space-y-3 ${!emailActive ? 'opacity-50 pointer-events-none' : ''}`}>
                    {smtpLoaded && [
                      { key: 'smtp_host', label: 'SMTP Host', placeholder: 'mail.example.com' },
                      { key: 'smtp_port', label: 'SMTP Port', placeholder: '587' },
                      { key: 'smtp_user', label: 'SMTP User', placeholder: 'trek@example.com' },
                      { key: 'smtp_pass', label: 'SMTP Password', placeholder: '••••••••', type: 'password' },
                      { key: 'smtp_from', label: 'From Address', placeholder: 'trek@example.com' },
                    ].map(field => (
                      <div key={field.key}>
                        <label className="block text-xs font-medium text-slate-500 mb-1">{field.label}</label>
                        <input
                          type={field.type || 'text'}
                          value={smtpValues[field.key] || ''}
                          onChange={e => setSmtpValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                          placeholder={field.placeholder}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                        />
                      </div>
                    ))}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
                      <div>
                        <span className="text-xs font-medium text-slate-500">Skip TLS certificate check</span>
                        <p className="text-[10px] text-slate-400 mt-0.5">Enable for self-signed certificates on local mail servers</p>
                      </div>
                      <button onClick={() => {
                        const newVal = smtpValues.smtp_skip_tls_verify === 'true' ? 'false' : 'true'
                        setSmtpValues(prev => ({ ...prev, smtp_skip_tls_verify: newVal }))
                      }}
                        className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
                        style={{ background: smtpValues.smtp_skip_tls_verify === 'true' ? 'var(--text-primary)' : 'var(--border-primary)' }}>
                        <span className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                          style={{ transform: smtpValues.smtp_skip_tls_verify === 'true' ? 'translateX(20px)' : 'translateX(0)' }} />
                      </button>
                    </div>
                  </div>
                  <div className="px-6 pb-4 flex items-center gap-2 border-t border-slate-100 pt-4">
                    <button onClick={saveNotifications}
                      className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors">
                      <Save className="w-4 h-4" />{t('common.save')}
                    </button>
                    <button
                      onClick={async () => {
                        const smtpKeys = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_skip_tls_verify']
                        const payload: Record<string, string> = {}
                        for (const k of smtpKeys) { if (smtpValues[k] !== undefined) payload[k] = smtpValues[k] }
                        await authApi.updateAppSettings(payload).catch(() => {})
                        try {
                          const result = await notificationsApi.testSmtp()
                          if (result.success) toast.success(t('admin.smtp.testSuccess'))
                          else toast.error(result.error || t('admin.smtp.testFailed'))
                        } catch { toast.error(t('admin.smtp.testFailed')) }
                      }}
                      disabled={!smtpConfigured}
                      className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors disabled:opacity-40"
                    >
                      {t('admin.smtp.testButton')}
                    </button>
                  </div>
                </div>

                {/* Webhook Panel */}
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-6 py-4 flex items-center justify-between">
                    <div>
                      <h2 className="font-semibold text-slate-900">{t('admin.notifications.webhookPanel.title')}</h2>
                      <p className="text-xs text-slate-400 mt-1">{t('admin.webhook.hint')}</p>
                    </div>
                    <button
                      onClick={() => setChannels(emailActive, !webhookActive)}
                      className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0"
                      style={{ background: webhookActive ? 'var(--text-primary)' : 'var(--border-primary)' }}
                    >
                      <span className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                        style={{ transform: webhookActive ? 'translateX(20px)' : 'translateX(0)' }} />
                    </button>
                  </div>
                </div>

                {/* In-App Panel */}
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                    <div>
                      <h2 className="font-semibold text-slate-900">{t('admin.notifications.inappPanel.title')}</h2>
                      <p className="text-xs text-slate-400 mt-1">{t('admin.notifications.inappPanel.hint')}</p>
                    </div>
                    <div className="relative inline-flex h-6 w-11 items-center rounded-full flex-shrink-0"
                      style={{ background: 'var(--text-primary)', opacity: 0.5, cursor: 'not-allowed' }}>
                      <span className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                        style={{ transform: 'translateX(20px)' }} />
                    </div>
                  </div>
                </div>

                {/* Admin Webhook Panel */}
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-6 py-4 border-b border-slate-100">
                    <h2 className="font-semibold text-slate-900">{t('admin.notifications.adminWebhookPanel.title')}</h2>
                    <p className="text-xs text-slate-400 mt-1">{t('admin.notifications.adminWebhookPanel.hint')}</p>
                  </div>
                  <div className="p-6 space-y-3">
                    {smtpLoaded && (
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">{t('admin.notifications.adminWebhookPanel.title')}</label>
                        <input
                          type="text"
                          value={smtpValues.admin_webhook_url === '••••••••' ? '' : smtpValues.admin_webhook_url || ''}
                          onChange={e => setSmtpValues(prev => ({ ...prev, admin_webhook_url: e.target.value }))}
                          placeholder={smtpValues.admin_webhook_url === '••••••••' ? '••••••••' : 'https://discord.com/api/webhooks/...'}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                        />
                      </div>
                    )}
                  </div>
                  <div className="px-6 pb-4 flex items-center gap-2 border-t border-slate-100 pt-4">
                    <button
                      onClick={async () => {
                        try {
                          await authApi.updateAppSettings({ admin_webhook_url: smtpValues.admin_webhook_url || '' })
                          toast.success(t('admin.notifications.adminWebhookPanel.saved'))
                        } catch { toast.error(t('common.error')) }
                      }}
                      className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors">
                      <Save className="w-4 h-4" />{t('common.save')}
                    </button>
                    <button
                      onClick={async () => {
                        const url = smtpValues.admin_webhook_url === '••••••••' ? undefined : smtpValues.admin_webhook_url
                        if (!url && smtpValues.admin_webhook_url !== '••••••••') return
                        try {
                          if (url) await authApi.updateAppSettings({ admin_webhook_url: url }).catch(() => {})
                          const result = await notificationsApi.testWebhook(url)
                          if (result.success) toast.success(t('admin.notifications.adminWebhookPanel.testSuccess'))
                          else toast.error(result.error || t('admin.notifications.adminWebhookPanel.testFailed'))
                        } catch { toast.error(t('admin.notifications.adminWebhookPanel.testFailed')) }
                      }}
                      disabled={!smtpValues.admin_webhook_url?.trim()}
                      className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors disabled:opacity-40"
                    >
                      {t('admin.smtp.testButton')}
                    </button>
                  </div>
                </div>

              </div>
              <div className="mt-6">
                <AdminNotificationsPanel t={t} toast={toast} />
              </div>
            </>)
          })()}

          {activeTab === 'backup' && <BackupPanel />}

          {activeTab === 'audit' && <AuditLogPanel serverTimezone={serverTimezone} />}

          {activeTab === 'mcp-tokens' && <AdminMcpTokensPanel />}

          {activeTab === 'github' && <GitHubPanel />}

          {activeTab === 'dev-notifications' && <DevNotificationsPanel />}
        </div>
      </div>

      {/* Create user modal */}
      <Modal
        isOpen={showCreateUser}
        onClose={() => setShowCreateUser(false)}
        title={t('admin.createUser')}
        size="sm"
        footer={
          <div className="flex gap-3 justify-end">
            <button
              onClick={() => setShowCreateUser(false)}
              className="px-4 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleCreateUser}
              className="px-4 py-2 text-sm bg-slate-900 hover:bg-slate-700 text-white rounded-lg"
            >
              {t('admin.createUser')}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.username')} *</label>
            <input
              type="text"
              value={createForm.username}
              onChange={e => setCreateForm(f => ({ ...f, username: e.target.value }))}
              placeholder={t('settings.username')}
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-slate-400 focus:border-transparent text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('common.email')} *</label>
            <input
              type="email"
              value={createForm.email}
              onChange={e => setCreateForm(f => ({ ...f, email: e.target.value }))}
              placeholder={t('common.email')}
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-slate-400 focus:border-transparent text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('common.password')} *</label>
            <input
              type="password"
              value={createForm.password}
              onChange={e => setCreateForm(f => ({ ...f, password: e.target.value }))}
              placeholder={t('common.password')}
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-slate-400 focus:border-transparent text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.role')}</label>
            <CustomSelect
              value={createForm.role}
              onChange={value => setCreateForm(f => ({ ...f, role: value }))}
              options={[
                { value: 'user', label: t('settings.roleUser') },
                { value: 'admin', label: t('settings.roleAdmin') },
              ]}
            />
          </div>
        </div>
      </Modal>

      {/* Edit user modal */}
      <Modal
        isOpen={!!editingUser}
        onClose={() => setEditingUser(null)}
        title={t('admin.editUser')}
        size="sm"
        footer={
          <div className="flex gap-3 justify-end">
            <button
              onClick={() => setEditingUser(null)}
              className="px-4 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSaveUser}
              className="px-4 py-2 text-sm bg-slate-900 hover:bg-slate-700 text-white rounded-lg"
            >
              {t('common.save')}
            </button>
          </div>
        }
      >
        {editingUser && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.username')}</label>
              <input
                type="text"
                value={editForm.username}
                onChange={e => setEditForm(f => ({ ...f, username: e.target.value }))}
                className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-slate-400 focus:border-transparent text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('common.email')}</label>
              <input
                type="email"
                value={editForm.email}
                onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))}
                className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-slate-400 focus:border-transparent text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('admin.newPassword')} <span className="text-slate-400 font-normal">({t('admin.newPasswordHint')})</span></label>
              <input
                type="password"
                value={editForm.password}
                onChange={e => setEditForm(f => ({ ...f, password: e.target.value }))}
                placeholder={t('admin.newPasswordPlaceholder')}
                className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-slate-400 focus:border-transparent text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.role')}</label>
              <CustomSelect
                value={editForm.role}
                onChange={value => setEditForm(f => ({ ...f, role: value }))}
                options={[
                  { value: 'user', label: t('settings.roleUser') },
                  { value: 'admin', label: t('settings.roleAdmin') },
                ]}
              />
            </div>
          </div>
        )}
      </Modal>

      {/* Update instructions popup */}
      {showUpdateModal && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => setShowUpdateModal(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 440, borderRadius: 16, overflow: 'hidden' }}
            className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700"
          >
            <div style={{ background: 'linear-gradient(135deg, #0f172a, #1e293b)', padding: '20px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <ArrowUpCircle size={20} style={{ color: 'white' }} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'white' }}>{t('admin.update.howTo')}</h3>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>
                  v{updateInfo?.current} → v{updateInfo?.latest}
                </p>
              </div>
            </div>

            <div style={{ padding: '20px 24px' }}>
              <p className="text-gray-700 dark:text-gray-300" style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
                {t('admin.update.dockerText').replace('{version}', `v${updateInfo?.latest ?? ''}`)}
              </p>

              <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 10, fontSize: 12, lineHeight: 1.8, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                className="bg-gray-900 dark:bg-gray-950 text-gray-100 border border-gray-700"
              >
{`docker pull mauriceboe/trek:latest
docker stop trek && docker rm trek
docker run -d --name trek \\
  -p 3000:3000 \\
  -v /opt/trek/data:/app/data \\
  -v /opt/trek/uploads:/app/uploads \\
  --restart unless-stopped \\
  mauriceboe/trek:latest`}
              </div>

              <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, fontSize: 12, lineHeight: 1.5 }}
                className="bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
              >
                <div className="flex items-start gap-2">
                  <CheckCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>{t('admin.update.dataInfo')}</span>
                </div>
              </div>

              {updateInfo?.release_url && (
                <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, fontSize: 12, lineHeight: 1.5 }}
                  className="bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
                >
                  <div className="flex items-start gap-2">
                    <ExternalLink className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>
                      <a href={updateInfo.release_url} target="_blank" rel="noopener noreferrer" className="underline font-semibold">
                        {t('admin.update.button')}
                      </a>
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div style={{ padding: '0 24px 20px', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowUpdateModal(false)}
                className="bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-gray-200"
                style={{ padding: '9px 20px', borderRadius: 10, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rotate JWT Secret confirmation modal */}
      <Modal
        isOpen={showRotateJwtModal}
        onClose={() => setShowRotateJwtModal(false)}
        title="Rotate JWT Secret"
        size="sm"
        footer={
          <div className="flex gap-3 justify-end">
            <button
              onClick={() => setShowRotateJwtModal(false)}
              disabled={rotatingJwt}
              className="px-4 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={async () => {
                setRotatingJwt(true)
                try {
                  await adminApi.rotateJwtSecret()
                  setShowRotateJwtModal(false)
                  logout()
                  navigate('/login', { state: { noRedirect: true } })
                } catch {
                  toast.error(t('common.error'))
                  setRotatingJwt(false)
                }
              }}
              disabled={rotatingJwt}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white rounded-lg font-medium"
            >
              {rotatingJwt ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Rotate &amp; Log out
            </button>
          </div>
        }
      >
        <div className="flex gap-3">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-red-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-slate-900 mb-1">Warning, this will invalidate all sessions and log you out.</p>
            <p className="text-xs text-slate-500">A new JWT secret will be generated immediately. Every logged-in user — including you — will be signed out and will need to log in again.</p>
          </div>
        </div>
      </Modal>
    </div>
  )
}
