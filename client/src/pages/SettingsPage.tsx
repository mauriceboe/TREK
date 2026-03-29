import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useSettingsStore } from '../store/settingsStore'
import { SUPPORTED_LANGUAGES, useTranslation } from '../i18n'
import Navbar from '../components/Layout/Navbar'
import CustomSelect from '../components/shared/CustomSelect'
import { useToast } from '../components/shared/Toast'
import { Save, Map, Palette, User, Moon, Sun, Monitor, Shield, Camera, Trash2, Lock, KeyRound, Bot, Plus, Key, Copy, Check } from 'lucide-react'
import { authApi, adminApi, mcpApi } from '../api/client'
import apiClient from '../api/client'
import type { LucideIcon } from 'lucide-react'
import type { UserWithOidc } from '../types'
import { getApiErrorMessage } from '../types'

interface MapPreset {
  name: string
  url: string
}

const MAP_PRESETS: MapPreset[] = [
  { name: 'OpenStreetMap', url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png' },
  { name: 'OpenStreetMap DE', url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png' },
  { name: 'CartoDB Light', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' },
  { name: 'CartoDB Dark', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png' },
  { name: 'Stadia Smooth', url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png' },
]

interface SectionProps {
  title: string
  icon: LucideIcon
  children: React.ReactNode
}

function Section({ title, icon: Icon, children }: SectionProps): React.ReactElement {
  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
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

export default function SettingsPage(): React.ReactElement {
  const { user, updateProfile, uploadAvatar, deleteAvatar, logout, loadUser, demoMode } = useAuthStore()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean | 'blocked'>(false)
  const avatarInputRef = React.useRef<HTMLInputElement>(null)
  const { settings, updateSetting, updateSettings } = useSettingsStore()
  const { t, locale } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()

  const [saving, setSaving] = useState<Record<string, boolean>>({})

  // Immich
  const [memoriesEnabled, setMemoriesEnabled] = useState(false)
  const [immichUrl, setImmichUrl] = useState('')
  const [immichApiKey, setImmichApiKey] = useState('')
  const [immichConnected, setImmichConnected] = useState(false)
  const [immichTesting, setImmichTesting] = useState(false)

  // MCP
  const [mcpEnabled, setMcpEnabled] = useState(false)
  const [mcpTokens, setMcpTokens] = useState<Array<{ id: number; name: string; token_prefix: string; last_used: string | null; expires_at: string | null; created_at: string }>>([]
  )
  const [mcpNewName, setMcpNewName] = useState('')
  const [mcpNewExpiry, setMcpNewExpiry] = useState('')
  const [mcpCreating, setMcpCreating] = useState(false)
  const [mcpRevealed, setMcpRevealed] = useState<{ token: string; id: number; name: string } | null>(null)
  const [mcpCopied, setMcpCopied] = useState(false)

  useEffect(() => {
    apiClient.get('/addons').then(r => {
      const mem = r.data.addons?.find((a: any) => a.id === 'memories' && a.enabled)
      setMemoriesEnabled(!!mem)
      if (mem) {
        apiClient.get('/integrations/immich/settings').then(r2 => {
          setImmichUrl(r2.data.immich_url || '')
          setImmichConnected(r2.data.connected)
        }).catch(() => {})
      }
      const mcp = r.data.addons?.find((a: any) => a.id === 'mcp' && a.enabled)
      setMcpEnabled(!!mcp)
      if (mcp) {
        mcpApi.listTokens().then((d: any) => setMcpTokens(d.tokens || [])).catch(() => {})
      }
    }).catch(() => {})
  }, [])

  const handleMcpCreate = async () => {
    if (!mcpNewName.trim()) return
    setMcpCreating(true)
    try {
      const data: any = await mcpApi.createToken({
        name: mcpNewName.trim(),
        ...(mcpNewExpiry ? { expires_at: new Date(mcpNewExpiry).toISOString() } : {}),
      })
      setMcpRevealed({ token: data.token, id: data.id, name: data.name })
      setMcpNewName('')
      setMcpNewExpiry('')
      const d: any = await mcpApi.listTokens()
      setMcpTokens(d.tokens || [])
    } catch { toast.error('Failed to create MCP token') }
    finally { setMcpCreating(false) }
  }

  const handleMcpRevoke = async (id: number) => {
    if (!confirm('Revoke this token? Any AI clients using it will lose access immediately.')) return
    try {
      await mcpApi.deleteToken(id)
      setMcpTokens(prev => prev.filter(t => t.id !== id))
      toast.success('Token revoked')
    } catch { toast.error('Failed to revoke token') }
  }

  const handleMcpCopy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    setMcpCopied(true)
    setTimeout(() => setMcpCopied(false), 2000)
  }

  const handleSaveImmich = async () => {
    setSaving(s => ({ ...s, immich: true }))
    try {
      await apiClient.put('/integrations/immich/settings', { immich_url: immichUrl, immich_api_key: immichApiKey || undefined })
      toast.success(t('memories.saved'))
      // Test connection
      const res = await apiClient.get('/integrations/immich/status')
      setImmichConnected(res.data.connected)
    } catch {
      toast.error(t('memories.connectionError'))
    } finally {
      setSaving(s => ({ ...s, immich: false }))
    }
  }

  const handleTestImmich = async () => {
    setImmichTesting(true)
    try {
      const res = await apiClient.get('/integrations/immich/status')
      if (res.data.connected) {
        toast.success(`${t('memories.connectionSuccess')} — ${res.data.user?.name || ''}`)
        setImmichConnected(true)
      } else {
        toast.error(`${t('memories.connectionError')}: ${res.data.error}`)
        setImmichConnected(false)
      }
    } catch {
      toast.error(t('memories.connectionError'))
    } finally {
      setImmichTesting(false)
    }
  }

  // Map settings
  const [mapTileUrl, setMapTileUrl] = useState<string>(settings.map_tile_url || '')
  const [defaultLat, setDefaultLat] = useState<number | string>(settings.default_lat || 48.8566)
  const [defaultLng, setDefaultLng] = useState<number | string>(settings.default_lng || 2.3522)
  const [defaultZoom, setDefaultZoom] = useState<number | string>(settings.default_zoom || 10)

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

  useEffect(() => {
    setMapTileUrl(settings.map_tile_url || '')
    setDefaultLat(settings.default_lat || 48.8566)
    setDefaultLng(settings.default_lng || 2.3522)
    setDefaultZoom(settings.default_zoom || 10)
    setTempUnit(settings.temperature_unit || 'celsius')
  }, [settings])

  useEffect(() => {
    setUsername(user?.username || '')
    setEmail(user?.email || '')
  }, [user])

  const saveMapSettings = async (): Promise<void> => {
    setSaving(s => ({ ...s, map: true }))
    try {
      await updateSettings({
        map_tile_url: mapTileUrl,
        default_lat: parseFloat(String(defaultLat)),
        default_lng: parseFloat(String(defaultLng)),
        default_zoom: parseInt(String(defaultZoom)),
      })
      toast.success(t('settings.toast.mapSaved'))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Error')
    } finally {
      setSaving(s => ({ ...s, map: false }))
    }
  }

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
        <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
          <div>
            <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.title')}</h1>
            <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>{t('settings.subtitle')}</p>
          </div>

          {/* Map settings */}
          <Section title={t('settings.map')} icon={Map}>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.mapTemplate')}</label>
              <CustomSelect
                value=""
                onChange={(value: string) => { if (value) setMapTileUrl(value) }}
                placeholder={t('settings.mapTemplatePlaceholder.select')}
                options={MAP_PRESETS.map(p => ({
                  value: p.url,
                  label: p.name,
                }))}
                size="sm"
                style={{ marginBottom: 8 }}
              />
              <input
                type="text"
                value={mapTileUrl}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMapTileUrl(e.target.value)}
                placeholder="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
              />
              <p className="text-xs text-slate-400 mt-1">{t('settings.mapDefaultHint')}</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.latitude')}</label>
                <input
                  type="number"
                  step="any"
                  value={defaultLat}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDefaultLat(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.longitude')}</label>
                <input
                  type="number"
                  step="any"
                  value={defaultLng}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDefaultLng(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                />
              </div>
            </div>

            <button
              onClick={saveMapSettings}
              disabled={saving.map}
              className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:bg-slate-400"
            >
              {saving.map ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
              {t('settings.saveMap')}
            </button>
          </Section>

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
          </Section>

          {/* MCP — only when MCP addon is enabled */}
          {mcpEnabled && (
            <Section title="AI / MCP" icon={Bot}>
              <div className="space-y-4">
                {mcpRevealed && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                    <p className="text-sm font-medium text-amber-800 mb-2 flex items-center gap-2">
                      <Key className="w-4 h-4" /> Token created — copy it now, it won't be shown again
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 bg-white border border-amber-200 rounded px-3 py-2 text-xs font-mono break-all" style={{ color: 'var(--text-primary)' }}>
                        {mcpRevealed.token}
                      </code>
                      <button onClick={() => handleMcpCopy(mcpRevealed.token)}
                        className="flex-shrink-0 p-2 rounded-lg border border-amber-200 bg-white hover:bg-amber-50 text-amber-700 transition-colors">
                        {mcpCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                    <button onClick={() => setMcpRevealed(null)} className="mt-2 text-xs text-amber-600 hover:text-amber-800">I've saved it — dismiss</button>
                  </div>
                )}

                <div>
                  <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>Create Service Token</p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input type="text" value={mcpNewName} onChange={e => setMcpNewName(e.target.value)}
                      placeholder="Token name (e.g. Claude Desktop)"
                      className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
                      style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
                      onKeyDown={e => e.key === 'Enter' && handleMcpCreate()} />
                    <input type="date" value={mcpNewExpiry} onChange={e => setMcpNewExpiry(e.target.value)}
                      title="Expiry date (optional)"
                      className="px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
                      style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} />
                    <button onClick={handleMcpCreate} disabled={mcpCreating || !mcpNewName.trim()}
                      className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap">
                      <Plus className="w-4 h-4" /> {mcpCreating ? 'Creating…' : 'Create'}
                    </button>
                  </div>
                </div>

                {mcpTokens.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Your Tokens</p>
                    {mcpTokens.map(t => (
                      <div key={t.id} className="flex items-center justify-between p-3 rounded-lg border"
                        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{t.name}</p>
                          <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                            <code className="font-mono">{t.token_prefix}…</code>
                            {t.last_used && <span className="ml-3">Last used: {new Date(t.last_used).toLocaleDateString()}</span>}
                            {t.expires_at && <span className="ml-3">Expires: {new Date(t.expires_at).toLocaleDateString()}</span>}
                          </p>
                        </div>
                        <button onClick={() => handleMcpRevoke(t.id)}
                          className="ml-3 p-1.5 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                          style={{ color: 'var(--text-secondary)' }} title="Revoke token">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="rounded-lg p-4 border text-xs space-y-1" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                  <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>How to connect your AI client</p>
                  <p>1. Create a service token above</p>
                  <p>2. SSE URL: <code className="font-mono">https://trek.yourdomain.com/api/mcp</code></p>
                  <p>3. Authorization header: <code className="font-mono">Bearer &lt;your-token&gt;</code></p>
                </div>
              </div>
            </Section>
          )}

          {/* Immich — only when Memories addon is enabled */}
          {memoriesEnabled && (
            <Section title="Immich" icon={Camera}>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('memories.immichUrl')}</label>
                  <input type="url" value={immichUrl} onChange={e => setImmichUrl(e.target.value)}
                    placeholder="https://immich.example.com"
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-300" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('memories.immichApiKey')}</label>
                  <input type="password" value={immichApiKey} onChange={e => setImmichApiKey(e.target.value)}
                    placeholder={immichConnected ? '••••••••' : 'API Key'}
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-300" />
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={handleSaveImmich} disabled={saving.immich}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:bg-slate-400">
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
                                await authApi.mfaEnable({ code: mfaSetupCode })
                                toast.success(t('settings.mfa.toastEnabled'))
                                setMfaQr(null)
                                setMfaSecret(null)
                                setMfaSetupCode('')
                                await loadUser()
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
                              await loadUser()
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
  )
}
