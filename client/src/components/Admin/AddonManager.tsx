import { useEffect, useState } from 'react'
import { adminApi } from '../../api/client'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../store/settingsStore'
import { useToast } from '../shared/Toast'
import { Puzzle, ListChecks, Wallet, FileText, CalendarDays, Globe, Briefcase, Image } from 'lucide-react'

const ICON_MAP = {
  ListChecks, Wallet, FileText, CalendarDays, Puzzle, Globe, Briefcase, Image,
}

interface Addon {
  id: string
  name: string
  description: string
  icon: string
  enabled: boolean
  type: string
}

interface AddonIconProps {
  name: string
  size?: number
}

function AddonIcon({ name, size = 20 }: AddonIconProps) {
  const Icon = ICON_MAP[name] || Puzzle
  return <Icon size={size} />
}

export default function AddonManager({ bagTrackingEnabled, onToggleBagTracking }: { bagTrackingEnabled?: boolean; onToggleBagTracking?: () => void }) {
  const { t } = useTranslation()
  const dm = useSettingsStore(s => s.settings.dark_mode)
  const dark = dm === true || dm === 'dark' || (dm === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const toast = useToast()
  const [addons, setAddons] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadAddons()
  }, [])

  const loadAddons = async () => {
    setLoading(true)
    try {
      const data = await adminApi.addons()
      setAddons(data.addons)
    } catch (err: unknown) {
      toast.error(t('admin.addons.toast.error'))
    } finally {
      setLoading(false)
    }
  }

  const handleToggle = async (addon) => {
    const newEnabled = !addon.enabled
    // Optimistic update
    setAddons(prev => prev.map(a => a.id === addon.id ? { ...a, enabled: newEnabled } : a))
    try {
      await adminApi.updateAddon(addon.id, { enabled: newEnabled })
      window.dispatchEvent(new Event('addons-changed'))
      toast.success(t('admin.addons.toast.updated'))
    } catch (err: unknown) {
      // Rollback
      setAddons(prev => prev.map(a => a.id === addon.id ? { ...a, enabled: !newEnabled } : a))
      toast.error(t('admin.addons.toast.error'))
    }
  }

  const tripAddons = addons.filter(a => a.type === 'trip')
  const globalAddons = addons.filter(a => a.type === 'global')

  if (loading) {
    return (
      <div className="p-8 text-center">
        <div className="w-8 h-8 border-2 border-slate-200 border-t-slate-900 rounded-full animate-spin mx-auto" style={{ borderTopColor: 'var(--text-primary)' }}></div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
        <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border-secondary)' }}>
          <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('admin.addons.title')}</h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            {t('admin.addons.subtitleBefore')}<img src={dark ? '/text-light.svg' : '/text-dark.svg'} alt="TREK" style={{ height: 11, display: 'inline', verticalAlign: 'middle', opacity: 0.7 }} />{t('admin.addons.subtitleAfter')}
          </p>
        </div>

        {addons.length === 0 ? (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--text-faint)' }}>
            {t('admin.addons.noAddons')}
          </div>
        ) : (
          <div>
            {/* Trip Addons */}
            {tripAddons.length > 0 && (
              <div>
                <div className="px-6 py-2.5 border-b flex items-center gap-2" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-secondary)' }}>
                  <Briefcase size={13} style={{ color: 'var(--text-muted)' }} />
                  <span className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    {t('admin.addons.type.trip')} — {t('admin.addons.tripHint')}
                  </span>
                </div>
                {tripAddons.map(addon => (
                  <div key={addon.id}>
                    <AddonRow addon={addon} onToggle={handleToggle} t={t} />
                    {addon.id === 'packing' && addon.enabled && onToggleBagTracking && (
                      <div className="flex items-center gap-4 px-6 py-3 border-b" style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-secondary)', paddingLeft: 70 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('admin.bagTracking.title')}</div>
                          <div className="text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>{t('admin.bagTracking.subtitle')}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="hidden sm:inline text-xs font-medium" style={{ color: bagTrackingEnabled ? 'var(--text-primary)' : 'var(--text-faint)' }}>
                            {bagTrackingEnabled ? t('admin.addons.enabled') : t('admin.addons.disabled')}
                          </span>
                          <button onClick={onToggleBagTracking}
                            className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
                            style={{ background: bagTrackingEnabled ? 'var(--text-primary)' : 'var(--border-primary)' }}>
                            <span className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                              style={{ transform: bagTrackingEnabled ? 'translateX(20px)' : 'translateX(0)' }} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Global Addons */}
            {globalAddons.length > 0 && (
              <div>
                <div className="px-6 py-2.5 border-b border-t flex items-center gap-2" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-secondary)' }}>
                  <Globe size={13} style={{ color: 'var(--text-muted)' }} />
                  <span className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    {t('admin.addons.type.global')} — {t('admin.addons.globalHint')}
                  </span>
                </div>
                {globalAddons.map(addon => (
                  <AddonRow key={addon.id} addon={addon} onToggle={handleToggle} t={t} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface AddonRowProps {
  addon: Addon
  onToggle: (addonId: string) => void
  t: (key: string) => string
}

function getAddonLabel(t: (key: string) => string, addon: Addon): { name: string; description: string } {
  const nameKey = `admin.addons.catalog.${addon.id}.name`
  const descKey = `admin.addons.catalog.${addon.id}.description`
  const translatedName = t(nameKey)
  const translatedDescription = t(descKey)

  return {
    name: translatedName !== nameKey ? translatedName : addon.name,
    description: translatedDescription !== descKey ? translatedDescription : addon.description,
  }
}

function AddonRow({ addon, onToggle, t }: AddonRowProps) {
  const isComingSoon = false
  const label = getAddonLabel(t, addon)
  return (
    <div className="flex items-center gap-4 px-6 py-4 border-b transition-colors hover:opacity-95" style={{ borderColor: 'var(--border-secondary)', opacity: isComingSoon ? 0.5 : 1, pointerEvents: isComingSoon ? 'none' : 'auto' }}>
      {/* Icon */}
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
        <AddonIcon name={addon.icon} size={20} />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{label.name}</span>
          {isComingSoon && (
            <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-faint)' }}>
              Coming Soon
            </span>
          )}
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full" style={{
            background: addon.type === 'global' ? 'var(--bg-secondary)' : 'var(--bg-secondary)',
            color: 'var(--text-muted)',
          }}>
            {addon.type === 'global' ? t('admin.addons.type.global') : t('admin.addons.type.trip')}
          </span>
        </div>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{label.description}</p>
      </div>

      {/* Toggle */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="hidden sm:inline text-xs font-medium" style={{ color: (addon.enabled && !isComingSoon) ? 'var(--text-primary)' : 'var(--text-faint)' }}>
          {isComingSoon ? t('admin.addons.disabled') : addon.enabled ? t('admin.addons.enabled') : t('admin.addons.disabled')}
        </span>
        <button
          onClick={() => !isComingSoon && onToggle(addon.id)}
          disabled={isComingSoon}
          className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
          style={{ background: (addon.enabled && !isComingSoon) ? 'var(--text-primary)' : 'var(--border-primary)', cursor: isComingSoon ? 'not-allowed' : 'pointer' }}
        >
          <span
            className="inline-block h-4 w-4 transform rounded-full transition-transform"
            style={{
              background: 'var(--bg-card)',
              transform: (addon.enabled && !isComingSoon) ? 'translateX(22px)' : 'translateX(4px)',
            }}
          />
        </button>
      </div>
    </div>
  )
}
