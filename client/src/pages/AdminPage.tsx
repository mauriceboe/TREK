import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminApi, authApi } from '../api/client'
import { useAuthStore } from '../store/authStore'
import { useSettingsStore } from '../store/settingsStore'
import { useTranslation } from '../i18n'
import { getApiErrorMessage } from '../types'
import Navbar from '../components/Layout/Navbar'
import Modal from '../components/shared/Modal'
import { useToast } from '../components/shared/Toast'
import CategoryManager from '../components/Admin/CategoryManager'
import BackupPanel from '../components/Admin/BackupPanel'
import GitHubPanel from '../components/Admin/GitHubPanel'
import AddonManager from '../components/Admin/AddonManager'
import { Users, Map, Briefcase, Shield, Trash2, Edit2, Camera, FileText, Eye, EyeOff, Save, CheckCircle, XCircle, Loader2, UserPlus, ArrowUpCircle, ExternalLink, Download, AlertTriangle, RefreshCw, GitBranch, Sun, Bot } from 'lucide-react'
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
}

interface UpdateInfo {
  update_available: boolean
  latest: string
  current: string
  release_url?: string
  is_docker?: boolean
}

export default function AdminPage(): React.ReactElement {
  const { demoMode } = useAuthStore()
  const { t, locale } = useTranslation()
  const hour12 = useSettingsStore(s => s.settings.time_format) === '12h'
  const TABS = [
    { id: 'users', label: t('admin.tabs.users') },
    { id: 'categories', label: t('admin.tabs.categories') },
    { id: 'addons', label: t('admin.tabs.addons') },
    { id: 'settings', label: t('admin.tabs.settings') },
    { id: 'backup', label: t('admin.tabs.backup') },
    { id: 'github', label: t('admin.tabs.github') },
  ]

  const [activeTab, setActiveTab] = useState<string>('users')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null)
  const [editForm, setEditForm] = useState<{ username: string; email: string; role: string; password: string }>({ username: '', email: '', role: 'user', password: '' })
  const [showCreateUser, setShowCreateUser] = useState<boolean>(false)
  const [createForm, setCreateForm] = useState<{ username: string; email: string; password: string; role: string }>({ username: '', email: '', password: '', role: 'user' })

  // OIDC config
  const [oidcConfig, setOidcConfig] = useState<OidcConfig>({ issuer: '', client_id: '', client_secret: '', client_secret_set: false, display_name: '', oidc_only: false })
  const [savingOidc, setSavingOidc] = useState<boolean>(false)

  // Registration toggle
  const [allowRegistration, setAllowRegistration] = useState<boolean>(true)

  // File types
  const [allowedFileTypes, setAllowedFileTypes] = useState<string>('jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv')
  const [savingFileTypes, setSavingFileTypes] = useState<boolean>(false)

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
  const [updating, setUpdating] = useState<boolean>(false)
  const [updateResult, setUpdateResult] = useState<'success' | 'error' | null>(null)

  // AI config
  const [aiProvider, setAiProvider] = useState<string>('openai')
  const [aiApiKey, setAiApiKey] = useState<string>('')
  const [aiModel, setAiModel] = useState<string>('')
  const [aiBaseUrl, setAiBaseUrl] = useState<string>('')
  const [aiKeySet, setAiKeySet] = useState<boolean>(false)
  const [savingAi, setSavingAi] = useState<boolean>(false)
  const [validatingAi, setValidatingAi] = useState<boolean>(false)
  const [aiValidation, setAiValidation] = useState<{ valid?: boolean; error?: string } | null>(null)

  const { user: currentUser, updateApiKeys } = useAuthStore()
  const navigate = useNavigate()
  const toast = useToast()

  useEffect(() => {
    loadData()
    loadAppConfig()
    loadApiKeys()
    adminApi.getOidc().then(setOidcConfig).catch(() => {})
    adminApi.checkVersion().then(data => {
      if (data.update_available) setUpdateInfo(data)
    }).catch(() => {})
    adminApi.getAiConfig().then(data => {
      setAiProvider(data.provider || 'openai')
      setAiModel(data.model || '')
      setAiBaseUrl(data.base_url || '')
      setAiKeySet(data.api_key_set || false)
    }).catch(() => {})
  }, [])

  const loadData = async () => {
    setIsLoading(true)
    try {
      const [usersData, statsData] = await Promise.all([
        adminApi.users(),
        adminApi.stats(),
      ])
      setUsers(usersData.users)
      setStats(statsData)
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

  const handleInstallUpdate = async () => {
    setUpdating(true)
    setUpdateResult(null)
    try {
      await adminApi.installUpdate()
      setUpdateResult('success')
      // Server is restarting — poll until it comes back, then reload
      const poll = setInterval(async () => {
        try {
          await authApi.getAppConfig()
          clearInterval(poll)
          window.location.reload()
        } catch { /* still restarting */ }
      }, 2000)
    } catch {
      setUpdateResult('error')
      setUpdating(false)
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
      if (editForm.password.trim()) payload.password = editForm.password.trim()
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
              <h1 className="text-2xl font-bold text-slate-900">Administration</h1>
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
                {updateInfo.is_docker ? (
                  <button
                    onClick={() => setShowUpdateModal(true)}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-colors bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-gray-200"
                  >
                    <Download className="w-4 h-4" />
                    {t('admin.update.howTo')}
                  </button>
                ) : (
                  <button
                    onClick={() => setShowUpdateModal(true)}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-colors bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-gray-200"
                  >
                    <Download className="w-4 h-4" />
                    {t('admin.update.install')}
                  </button>
                )}
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
                                <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-sm font-medium text-slate-700">
                                  {u.username.charAt(0).toUpperCase()}
                                </div>
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
                            {new Date(u.created_at).toLocaleDateString(locale)}
                          </td>
                          <td className="px-5 py-3 text-sm text-slate-500">
                            {u.last_login ? new Date(u.last_login).toLocaleDateString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12 }) : '—'}
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

          {activeTab === 'categories' && <CategoryManager />}

          {activeTab === 'addons' && <AddonManager />}

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
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        allowRegistration ? 'bg-slate-900' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          allowRegistration ? 'translate-x-6' : 'translate-x-1'
                        }`}
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
                  <h2 className="font-semibold text-slate-900">AI Assistant</h2>
                  <p className="text-xs text-slate-400 mt-1">Configure an AI provider for smart trip suggestions, packing lists, and itinerary planning. Supports OpenAI and MiniMax.</p>
                </div>
                <div className="p-6 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">AI Provider</label>
                    <CustomSelect
                      value={aiProvider}
                      onChange={value => {
                        setAiProvider(value)
                        setAiModel('')
                        setAiBaseUrl('')
                        setAiValidation(null)
                      }}
                      options={[
                        { value: 'openai', label: 'OpenAI' },
                        { value: 'minimax', label: 'MiniMax' },
                      ]}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">API Key</label>
                    <div className="relative">
                      <input
                        type={showKeys.ai ? 'text' : 'password'}
                        value={aiApiKey}
                        onChange={e => { setAiApiKey(e.target.value); setAiValidation(null) }}
                        placeholder={aiKeySet ? '••••••••' : 'Enter API key'}
                        className="w-full pr-10 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                      />
                      <button
                        type="button"
                        onClick={() => toggleKey('ai')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                      >
                        {showKeys.ai ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      {aiProvider === 'minimax' ? 'Get your API key from minimax.io' : 'Get your API key from platform.openai.com'}
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Model (optional)</label>
                    <input
                      type="text"
                      value={aiModel}
                      onChange={e => setAiModel(e.target.value)}
                      placeholder={aiProvider === 'minimax' ? 'MiniMax-M2.7' : 'gpt-4o-mini'}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                    />
                    <p className="text-xs text-slate-400 mt-1">
                      {aiProvider === 'minimax' ? 'Available: MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5' : 'e.g. gpt-4o-mini, gpt-4o, gpt-4-turbo'}
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Base URL (optional)</label>
                    <input
                      type="url"
                      value={aiBaseUrl}
                      onChange={e => setAiBaseUrl(e.target.value)}
                      placeholder={aiProvider === 'minimax' ? 'https://api.minimax.io/v1' : 'https://api.openai.com/v1'}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                    />
                  </div>

                  {aiValidation && (
                    <div className={`text-xs flex items-center gap-1 ${aiValidation.valid ? 'text-emerald-600' : 'text-red-500'}`}>
                      <span className={`w-2 h-2 rounded-full inline-block ${aiValidation.valid ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
                      {aiValidation.valid ? 'Connection successful' : (aiValidation.error || 'Connection failed')}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        setSavingAi(true)
                        try {
                          const payload: Record<string, unknown> = { provider: aiProvider }
                          if (aiApiKey) payload.api_key = aiApiKey
                          if (aiModel) payload.model = aiModel
                          if (aiBaseUrl) payload.base_url = aiBaseUrl
                          await adminApi.updateAiConfig(payload)
                          setAiKeySet(!!aiApiKey || aiKeySet)
                          toast.success('AI settings saved')
                        } catch (err: unknown) {
                          toast.error(err instanceof Error ? err.message : 'Error saving AI settings')
                        } finally {
                          setSavingAi(false)
                        }
                      }}
                      disabled={savingAi}
                      className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:bg-slate-400"
                    >
                      {savingAi ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
                      {t('common.save')}
                    </button>
                    <button
                      onClick={async () => {
                        setValidatingAi(true)
                        setAiValidation(null)
                        try {
                          // Save first so validation uses current values
                          const payload: Record<string, unknown> = { provider: aiProvider }
                          if (aiApiKey) payload.api_key = aiApiKey
                          if (aiModel) payload.model = aiModel
                          if (aiBaseUrl) payload.base_url = aiBaseUrl
                          await adminApi.updateAiConfig(payload)
                          setAiKeySet(!!aiApiKey || aiKeySet)
                          const result = await adminApi.validateAi()
                          setAiValidation(result)
                        } catch (err: unknown) {
                          setAiValidation({ valid: false, error: 'Validation request failed' })
                        } finally {
                          setValidatingAi(false)
                        }
                      }}
                      disabled={validatingAi || (!aiApiKey && !aiKeySet)}
                      className="px-3 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                    >
                      {validatingAi ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Bot className="w-4 h-4" />
                      )}
                      Test Connection
                    </button>
                  </div>
                </div>
              </div>

              {/* OIDC / SSO Configuration */}
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
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ml-4 ${
                        oidcConfig.oidc_only ? 'bg-slate-900' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          oidcConfig.oidc_only ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  <button
                    onClick={async () => {
                      setSavingOidc(true)
                      try {
                        const payload: Record<string, unknown> = { issuer: oidcConfig.issuer, client_id: oidcConfig.client_id, display_name: oidcConfig.display_name, oidc_only: oidcConfig.oidc_only }
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
            </div>
          )}

          {activeTab === 'backup' && <BackupPanel />}

          {activeTab === 'github' && <GitHubPanel />}
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

      {/* Update confirmation popup — matches backup restore style */}
      {showUpdateModal && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => { if (!updating) setShowUpdateModal(false) }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 440, borderRadius: 16, overflow: 'hidden' }}
            className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700"
          >
            {updateResult === 'success' ? (
              <>
                <div style={{ background: 'linear-gradient(135deg, #16a34a, #15803d)', padding: '20px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <CheckCircle size={20} style={{ color: 'white' }} />
                  </div>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'white' }}>{t('admin.update.success')}</h3>
                  </div>
                </div>
                <div style={{ padding: '20px 24px', textAlign: 'center' }}>
                  <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
                  <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('admin.update.reloadHint')}</p>
                </div>
              </>
            ) : updateResult === 'error' ? (
              <>
                <div style={{ background: 'linear-gradient(135deg, #dc2626, #b91c1c)', padding: '20px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <XCircle size={20} style={{ color: 'white' }} />
                  </div>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'white' }}>{t('admin.update.failed')}</h3>
                  </div>
                </div>
                <div style={{ padding: '0 24px 20px', display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                  <button
                    onClick={() => { setShowUpdateModal(false); setUpdateResult(null) }}
                    className="bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-gray-200"
                    style={{ padding: '9px 20px', borderRadius: 10, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </>
            ) : (
              <>
                {/* Red header */}
                <div style={{ background: 'linear-gradient(135deg, #dc2626, #b91c1c)', padding: '20px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <AlertTriangle size={20} style={{ color: 'white' }} />
                  </div>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'white' }}>{t('admin.update.confirmTitle')}</h3>
                    <p style={{ margin: '2px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>
                      v{updateInfo?.current} → v{updateInfo?.latest}
                    </p>
                  </div>
                </div>

                {/* Body */}
                <div style={{ padding: '20px 24px' }}>
                  {updateInfo?.is_docker ? (
                    <>
                      <p className="text-gray-700 dark:text-gray-300" style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
                        {t('admin.update.dockerText').replace('{version}', `v${updateInfo.latest}`)}
                      </p>

                      <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 10, fontSize: 12, lineHeight: 1.8, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                        className="bg-gray-900 dark:bg-gray-950 text-gray-100 border border-gray-700"
                      >
{`docker pull mauriceboe/nomad:latest
docker stop nomad && docker rm nomad
docker run -d --name nomad \\
  -p 3000:3000 \\
  -v /opt/nomad/data:/app/data \\
  -v /opt/nomad/uploads:/app/uploads \\
  --restart unless-stopped \\
  mauriceboe/nomad:latest`}
                      </div>

                      <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, fontSize: 12, lineHeight: 1.5 }}
                        className="bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                      >
                        <div className="flex items-start gap-2">
                          <CheckCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                          <span>{t('admin.update.dataInfo')}</span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-gray-700 dark:text-gray-300" style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
                        {updateInfo && t('admin.update.confirmText').replace('{current}', `v${updateInfo.current}`).replace('{version}', `v${updateInfo.latest}`)}
                      </p>

                      <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10, fontSize: 12, lineHeight: 1.5 }}
                        className="bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                      >
                        <div className="flex items-start gap-2">
                          <CheckCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                          <span>{t('admin.update.dataInfo')}</span>
                        </div>
                      </div>

                      <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, fontSize: 12, lineHeight: 1.5 }}
                        className="bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
                      >
                        <div className="flex items-start gap-2">
                          <Download className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                          <span>
                            {t('admin.update.backupHint')}{' '}
                            <button
                              onClick={() => { setShowUpdateModal(false); setActiveTab('backup') }}
                              className="underline font-semibold hover:text-blue-950 dark:hover:text-blue-100"
                            >{t('admin.update.backupLink')}</button>
                          </span>
                        </div>
                      </div>

                      <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, fontSize: 12, lineHeight: 1.5 }}
                        className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800"
                      >
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                          <span>{t('admin.update.warning')}</span>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* Footer */}
                <div style={{ padding: '0 24px 20px', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setShowUpdateModal(false)}
                    disabled={updating}
                    className="text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40"
                    style={{ padding: '9px 20px', borderRadius: 10, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    {t('common.cancel')}
                  </button>
                  {!updateInfo?.is_docker && (
                    <button
                      onClick={handleInstallUpdate}
                      disabled={updating}
                      className="bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-gray-200 disabled:opacity-60 flex items-center gap-2"
                      style={{ padding: '9px 20px', borderRadius: 10, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      {updating ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Download size={14} />
                      )}
                      {updating ? t('admin.update.installing') : t('admin.update.confirm')}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
