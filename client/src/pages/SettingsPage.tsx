import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useSettingsStore } from '../store/settingsStore'
import { SUPPORTED_LANGUAGES, useTranslation } from '../i18n'
import Navbar from '../components/Layout/Navbar'
import CustomSelect from '../components/shared/CustomSelect'
import { useToast } from '../components/shared/Toast'
import { Save, Map, Palette, User, Moon, Sun, Monitor, Shield, Camera, Trash2, Lock, KeyRound, Copy, Printer, FileDown } from 'lucide-react'
import { authApi, adminApi } from '../api/client'
import type { LucideIcon } from 'lucide-react'
import type { UserWithOidc } from '../types'
import { getApiErrorMessage } from '../types'
import Modal from '../components/shared/Modal'

interface MapPreset {
  name: string
  url: string
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

/**
 * Prints via a hidden iframe (no pop-up). In the system dialog, choose "Save as PDF" or a printer.
 */
function printMfaBackupCodes(codes: string[], docTitle: string, docIntro: string, docFooter: string): void {
  const items = codes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>${escapeHtml(docTitle)}</title>
<style>
  @page { margin: 18mm; size: auto; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; padding: 12px 16px; color: #111; line-height: 1.5; max-width: 520px; margin: 0 auto; }
  h1 { font-size: 1.1rem; margin: 0 0 12px; }
  p.intro { font-size: 0.85rem; color: #444; margin: 0 0 16px; }
  ol { margin: 0; padding-left: 1.25rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9rem; line-height: 1.75; }
  p.footer { font-size: 0.75rem; color: #666; margin-top: 20px; border-top: 1px solid #ddd; padding-top: 12px; }
</style></head><body>
<h1>${escapeHtml(docTitle)}</h1>
<p class="intro">${escapeHtml(docIntro)}</p>
<ol>${items}</ol>
<p class="footer">${escapeHtml(docFooter)}</p>
</body></html>`

  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('title', 'print')
  Object.assign(iframe.style, {
    position: 'fixed',
    left: '-9999px',
    top: '0',
    width: '1px',
    height: '1px',
    opacity: '0',
    border: 'none',
    pointerEvents: 'none',
  })
  document.body.appendChild(iframe)

  const idoc = iframe.contentDocument
  const iwin = iframe.contentWindow
  if (!idoc || !iwin) {
    iframe.remove()
    return
  }

  idoc.open()
  idoc.write(html)
  idoc.close()

  const cleanup = (): void => {
    if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
  }

  const runPrint = (): void => {
    try {
      iwin.focus()
      iwin.print()
    } finally {
      setTimeout(cleanup, 500)
    }
  }

  // Defer so layout is ready in all engines (Safari/Firefox/Chrome)
  setTimeout(runPrint, 100)
}

function downloadMfaBackupCodesTxt(codes: string[], fileHeader: string): void {
  const text = `${fileHeader}\n\n${codes.join('\n')}\n`
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `trek-mfa-backup-codes-${new Date().toISOString().slice(0, 10)}.txt`
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
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
  const [mfaBackupCodesModal, setMfaBackupCodesModal] = useState<string[] | null>(null)

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
                                const data = await authApi.mfaEnable({ code: mfaSetupCode }) as {
                                  backup_codes?: string[]
                                }
                                toast.success(t('settings.mfa.toastEnabled'))
                                setMfaQr(null)
                                setMfaSecret(null)
                                setMfaSetupCode('')
                                if (data.backup_codes?.length) {
                                  setMfaBackupCodesModal(data.backup_codes)
                                }
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

          <Modal
            isOpen={!!mfaBackupCodesModal && mfaBackupCodesModal.length > 0}
            onClose={() => setMfaBackupCodesModal(null)}
            title={t('settings.mfa.backupCodesTitle')}
            size="lg"
            footer={(
              <div className="flex flex-wrap gap-2 justify-end items-center">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(mfaBackupCodesModal?.join('\n') ?? '')
                      toast.success(t('settings.mfa.backupCodesCopied'))
                    } catch {
                      toast.error(t('common.error'))
                    }
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border"
                  style={{ borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
                >
                  <Copy size={14} />
                  {t('settings.mfa.backupCodesCopyAll')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!mfaBackupCodesModal?.length) return
                    try {
                      printMfaBackupCodes(
                        mfaBackupCodesModal,
                        t('settings.mfa.backupCodesTitle'),
                        t('settings.mfa.backupCodesIntro'),
                        t('settings.mfa.backupCodesPrintFooter')
                      )
                    } catch {
                      toast.error(t('common.error'))
                    }
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border"
                  style={{ borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
                >
                  <Printer size={14} />
                  {t('settings.mfa.backupCodesPrint')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!mfaBackupCodesModal?.length) return
                    downloadMfaBackupCodesTxt(mfaBackupCodesModal, t('settings.mfa.backupCodesFileHeader'))
                    toast.success(t('settings.mfa.backupCodesSavedTxt'))
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border"
                  style={{ borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
                >
                  <FileDown size={14} />
                  {t('settings.mfa.backupCodesSaveTxt')}
                </button>
                <button
                  type="button"
                  onClick={() => setMfaBackupCodesModal(null)}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-slate-900 hover:bg-slate-700"
                >
                  {t('settings.mfa.backupCodesClose')}
                </button>
              </div>
            )}
          >
            <p className="text-sm m-0 mb-2" style={{ color: 'var(--text-muted)' }}>{t('settings.mfa.backupCodesIntro')}</p>
            <p className="text-sm m-0 mb-4 font-medium" style={{ color: '#b45309' }}>{t('settings.mfa.backupCodesWarning')}</p>
            <div
              className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3 rounded-xl font-mono text-sm"
              style={{ background: 'var(--bg-hover)', border: '1px solid var(--border-secondary)' }}
            >
              {mfaBackupCodesModal?.map((c, i) => (
                <div
                  key={`${c}-${i}`}
                  className="px-3 py-2 rounded-lg text-center select-all"
                  style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', letterSpacing: '0.02em' }}
                >
                  {c}
                </div>
              ))}
            </div>
          </Modal>

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
