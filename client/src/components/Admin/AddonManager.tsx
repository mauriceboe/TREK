import { useEffect, useState } from 'react'
import { adminApi } from '../../api/client'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../store/settingsStore'
import { useAddonStore } from '../../store/addonStore'
import { useToast } from '../shared/Toast'
import { Puzzle, ListChecks, Wallet, FileText, CalendarDays, Globe, Briefcase, Image, Terminal, Link2, Compass, BookOpen, MessageCircle, StickyNote, BarChart3, Sparkles, Luggage } from 'lucide-react'

const ICON_MAP = {
  ListChecks, Wallet, FileText, CalendarDays, Puzzle, Globe, Briefcase, Image, Terminal, Link2, Compass, BookOpen,
}

function ImmichIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} style={{ flexShrink: 0 }}>
      <path d="M11.986.27c-2.409 0-5.207 1.09-5.207 3.894v.152c1.343.597 2.935 1.663 4.412 2.971 1.571 1.391 2.838 2.882 3.653 4.287 1.4-2.503 2.336-5.478 2.347-7.373V4.164c0-2.803-2.796-3.894-5.205-3.894m7.512 4.49c-.378-.008-.775.05-1.192.186l-.144.047c-.153 1.461-.676 3.304-1.463 5.113-.837 1.924-1.863 3.59-2.947 4.799 2.813.558 5.93.527 7.736-.047l.035-.01c2.667-.866 2.84-3.863 2.096-6.154-.628-1.933-2.081-3.89-4.121-3.934m-14.996.04c-2.04.043-3.493 1.997-4.121 3.93-.744 2.291-.571 5.288 2.096 6.155l.144.046c.982-1.092 2.488-2.276 4.188-3.277 1.809-1.065 3.619-1.808 5.207-2.148-1.949-2.105-4.489-3.914-6.287-4.51l-.036-.012c-.416-.135-.813-.193-1.191-.185m4.672 6.758c-2.604 1.202-5.109 3.06-6.233 4.586l-.021.029c-1.648 2.268-.027 4.795 1.922 6.211 1.949 1.416 4.852 2.177 6.5-.092.023-.031.054-.07.09-.121-.736-1.272-1.396-3.072-1.822-4.998-.454-2.05-.603-4-.436-5.615m1.072 3.338c.339 2.848 1.332 5.804 2.436 7.344l.021.029c1.648 2.268 4.551 1.508 6.5.092 1.949-1.416 3.57-3.943 1.922-6.211-.023-.031-.052-.073-.088-.123-1.437.307-3.352.38-5.316.19-2.089-.202-3.99-.663-5.475-1.321" fill="currentColor" />
    </svg>
  )
}

function SynologyIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} style={{ flexShrink: 0 }}>
      <path d="M17.895 11.927a3.196 3.196 0 0 1 .394-1.53l-.008.017a2.677 2.677 0 0 1 1.075-1.108l.014-.007a3.181 3.181 0 0 1 1.523-.382h.05-.003q1.346 0 2.2.871.854.871.86 2.203c0 .895-.29 1.635-.867 2.226s-1.306.886-2.183.886c-.566 0-1.1-.137-1.571-.379l.019.009a2.535 2.535 0 0 1-1.115-1.067l-.007-.013q-.38-.708-.381-1.726zm1.593.083c0 .591.138 1.043.42 1.349a1.365 1.365 0 0 0 2.066.002l.001-.002c.275-.307.413-.764.413-1.357s-.138-1.033-.413-1.342a1.371 1.371 0 0 0-2.066-.001l-.001.002c-.281.306-.42.758-.42 1.345zm-1.602 2.941H16.33v-3.015c0-.635-.032-1.044-.101-1.234a.876.876 0 0 0-.328-.435l-.003-.002a.938.938 0 0 0-.521-.156h-.027.001-.012c-.27 0-.521.084-.727.228l.004-.003a1.115 1.115 0 0 0-.444.576l-.002.008c-.083.248-.121.696-.121 1.359v2.673H12.5V9.027h1.439v.867c.518-.656 1.167-.98 1.952-.98h.021c.335 0 .655.067.946.189l-.016-.006c.261.105.48.268.648.475l.002.003c.141.185.247.404.304.643l.002.012c.057.278.089.597.089.924l-.002.135v-.007zM6.413 9.028h1.654l1.412 4.204 1.376-4.204h1.611l-2.067 5.693-.38 1.038a4.158 4.158 0 0 1-.4.807l.01-.017a1.637 1.637 0 0 1-.422.443l-.005.003c-.17.113-.367.203-.578.26l-.014.003c-.232.064-.499.1-.774.1h-.025.001a4.13 4.13 0 0 1-.911-.105l.028.005-.129-1.229c.198.046.426.074.659.077h.002c.36 0 .628-.106.8-.318a2.27 2.27 0 0 0 .395-.807l.004-.016zM0 12.29l1.592-.149q.147.802.586 1.181.439.379 1.192.375c.528 0 .927-.113 1.197-.335.27-.222.4-.486.4-.782v-.024a.751.751 0 0 0-.167-.474l.001.001c-.113-.132-.309-.252-.59-.347-.193-.074-.631-.191-1.312-.365-.882-.216-1.496-.486-1.85-.804A2.147 2.147 0 0 1 .3 8.936v-.019V8.908c0-.431.132-.831.358-1.163l-.005.007a2.226 2.226 0 0 1 1.003-.826l.015-.005c.442-.184.973-.281 1.602-.281q1.529 0 2.304.676c.516.457.785 1.057.811 1.809l-1.649.055c-.073-.413-.219-.714-.452-.899-.233-.185-.579-.276-1.034-.276-.476 0-.85.098-1.118.298a.59.59 0 0 0-.261.49v.011-.001.002c0 .201.095.379.242.493l.001.001c.205.179.709.36 1.507.546.798.186 1.388.387 1.769.59.374.196.678.48.893.825l.006.01c.214.345.326.786.326 1.305 0 .489-.146.944-.396 1.325l.006-.009c-.264.408-.64.724-1.084.908l-.016.006c-.475.194-1.065.298-1.772.298-1.029 0-1.819-.241-2.373-.722-.554-.481-.879-1.177-.986-2.091z" fill="currentColor" />
    </svg>
  )
}

const PROVIDER_ICONS: Record<string, React.FC<{ size?: number }>> = {
  immich: ImmichIcon,
  synologyphotos: SynologyIcon,
}

interface Addon {
  id: string
  name: string
  description: string
  icon: string
  type: string
  enabled: boolean
  config?: Record<string, unknown>
}

interface ProviderOption {
  key: string
  label: string
  description: string
  enabled: boolean
  toggle: () => Promise<void>
}

interface AddonIconProps {
  name: string
  size?: number
}

function AddonIcon({ name, size = 20 }: AddonIconProps) {
  const Icon = ICON_MAP[name] || Puzzle
  return <Icon size={size} />
}

interface CollabFeatures { chat: boolean; notes: boolean; polls: boolean; whatsnext: boolean }

const COLLAB_SUB_FEATURES = [
  { key: 'chat', icon: MessageCircle, titleKey: 'admin.collab.chat.title', subtitleKey: 'admin.collab.chat.subtitle' },
  { key: 'notes', icon: StickyNote, titleKey: 'admin.collab.notes.title', subtitleKey: 'admin.collab.notes.subtitle' },
  { key: 'polls', icon: BarChart3, titleKey: 'admin.collab.polls.title', subtitleKey: 'admin.collab.polls.subtitle' },
  { key: 'whatsnext', icon: Sparkles, titleKey: 'admin.collab.whatsnext.title', subtitleKey: 'admin.collab.whatsnext.subtitle' },
] as const

export default function AddonManager({ bagTrackingEnabled, onToggleBagTracking, collabFeatures, onToggleCollabFeature }: { bagTrackingEnabled?: boolean; onToggleBagTracking?: () => void; collabFeatures?: CollabFeatures; onToggleCollabFeature?: (key: string) => void }) {
  const { t } = useTranslation()
  const dm = useSettingsStore(s => s.settings.dark_mode)
  const dark = dm === true || dm === 'dark' || (dm === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const toast = useToast()
  const refreshGlobalAddons = useAddonStore(s => s.loadAddons)
  const [addons, setAddons] = useState<Addon[]>([])
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

  const handleToggle = async (addon: Addon) => {
    const newEnabled = !addon.enabled
    // Optimistic update
    setAddons(prev => prev.map(a => a.id === addon.id ? { ...a, enabled: newEnabled } : a))
    try {
      await adminApi.updateAddon(addon.id, { enabled: newEnabled })
      refreshGlobalAddons()
      toast.success(t('admin.addons.toast.updated'))
    } catch (err: unknown) {
      // Rollback
      setAddons(prev => prev.map(a => a.id === addon.id ? { ...a, enabled: !newEnabled } : a))
      toast.error(t('admin.addons.toast.error'))
    }
  }

  const isPhotoProviderAddon = (addon: Addon) => {
    return addon.type === 'photo_provider'
  }

  const isPhotosAddon = (addon: Addon) => {
    const haystack = `${addon.id} ${addon.name} ${addon.description}`.toLowerCase()
    return addon.type === 'trip' && (addon.icon === 'Image' || haystack.includes('photo') || haystack.includes('memories'))
  }

  const handleTogglePhotoProvider = async (providerAddon: Addon) => {
    const enableProvider = !providerAddon.enabled
    const prev = addons

    setAddons(current => current.map(a => a.id === providerAddon.id ? { ...a, enabled: enableProvider } : a))

    try {
      await adminApi.updateAddon(providerAddon.id, { enabled: enableProvider })
      refreshGlobalAddons()
      toast.success(t('admin.addons.toast.updated'))
    } catch {
      setAddons(prev)
      toast.error(t('admin.addons.toast.error'))
    }
  }

  const photoProviderAddons = addons.filter(isPhotoProviderAddon)
  const photosAddon = addons.filter(a => a.type === 'trip').find(isPhotosAddon)
  const tripAddons = addons.filter(a => a.type === 'trip' && !isPhotosAddon(a))
  const globalAddons = addons.filter(a => a.type === 'global')
  const integrationAddons = addons.filter(a => a.type === 'integration')
  const providerOptions: ProviderOption[] = photoProviderAddons.map((provider) => ({
      key: provider.id,
      label: provider.name,
      description: provider.description,
      enabled: provider.enabled,
      toggle: () => handleTogglePhotoProvider(provider),
    }))
  const photosDerivedEnabled = providerOptions.some(p => p.enabled)

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
                        <Luggage size={14} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
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
                    {addon.id === 'collab' && addon.enabled && collabFeatures && onToggleCollabFeature && (
                      <div className="px-6 py-3 border-b" style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-secondary)', paddingLeft: 70 }}>
                        <div className="space-y-2">
                          {COLLAB_SUB_FEATURES.map(feat => {
                            const enabled = collabFeatures[feat.key]
                            const Icon = feat.icon
                            return (
                              <div key={feat.key} className="flex items-center gap-4" style={{ minHeight: 32 }}>
                                <Icon size={14} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t(feat.titleKey)}</div>
                                  <div className="text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>{t(feat.subtitleKey)}</div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <span className="hidden sm:inline text-xs font-medium" style={{ color: enabled ? 'var(--text-primary)' : 'var(--text-faint)' }}>
                                    {enabled ? t('admin.addons.enabled') : t('admin.addons.disabled')}
                                  </span>
                                  <button onClick={() => onToggleCollabFeature(feat.key)}
                                    className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
                                    style={{ background: enabled ? 'var(--text-primary)' : 'var(--border-primary)' }}>
                                    <span className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                                      style={{ transform: enabled ? 'translateX(20px)' : 'translateX(0)' }} />
                                  </button>
                                </div>
                              </div>
                            )
                          })}
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
                  <div key={addon.id}>
                    <AddonRow addon={addon} onToggle={handleToggle} t={t} />
                    {/* Memories providers as sub-items under Journey addon */}
                    {addon.id === 'journey' && providerOptions.length > 0 && (
                      <div className="px-6 py-3 border-b" style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-secondary)', paddingLeft: 70 }}>
                        <div className="space-y-2">
                          {providerOptions.map(provider => {
                            const ProviderIcon = PROVIDER_ICONS[provider.key]
                            return (
                            <div key={provider.key} className="flex items-center gap-4" style={{ minHeight: 32 }}>
                              {ProviderIcon && <span style={{ color: 'var(--text-faint)' }}><ProviderIcon size={14} /></span>}
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{provider.label}</div>
                                <div className="text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>{provider.description}</div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="hidden sm:inline text-xs font-medium" style={{ color: provider.enabled ? 'var(--text-primary)' : 'var(--text-faint)' }}>
                                  {provider.enabled ? t('admin.addons.enabled') : t('admin.addons.disabled')}
                                </span>
                                <button
                                  onClick={provider.toggle}
                                  className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
                                  style={{ background: provider.enabled ? 'var(--text-primary)' : 'var(--border-primary)' }}
                                >
                                  <span className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                                    style={{ transform: provider.enabled ? 'translateX(20px)' : 'translateX(0)' }} />
                                </button>
                              </div>
                            </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Integration Addons */}
            {integrationAddons.length > 0 && (
              <div>
                <div className="px-6 py-2.5 border-b border-t flex items-center gap-2" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-secondary)' }}>
                  <Link2 size={13} style={{ color: 'var(--text-muted)' }} />
                  <span className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    {t('admin.addons.type.integration')} — {t('admin.addons.integrationHint')}
                  </span>
                </div>
                {integrationAddons.map(addon => (
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
  onToggle: (addon: Addon) => void
  t: (key: string) => string
  statusOverride?: boolean
  hideToggle?: boolean
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

function AddonRow({ addon, onToggle, t, nameOverride, descriptionOverride, statusOverride, hideToggle }: AddonRowProps & { nameOverride?: string; descriptionOverride?: string }) {
  const isComingSoon = false
  const label = getAddonLabel(t, addon)
  const displayName = nameOverride || label.name
  const displayDescription = descriptionOverride || label.description
  const enabledState = statusOverride ?? addon.enabled
  return (
    <div className="flex items-center gap-4 px-6 py-4 border-b transition-colors hover:opacity-95" style={{ borderColor: 'var(--border-secondary)', opacity: isComingSoon ? 0.5 : 1, pointerEvents: isComingSoon ? 'none' : 'auto' }}>
      {/* Icon */}
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
        <AddonIcon name={addon.icon} size={20} />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{displayName}</span>
          {isComingSoon && (
            <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-faint)' }}>
              Coming Soon
            </span>
          )}
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
            {addon.type === 'global' ? t('admin.addons.type.global') : addon.type === 'integration' ? t('admin.addons.type.integration') : t('admin.addons.type.trip')}
          </span>
        </div>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{displayDescription}</p>
      </div>

      {/* Toggle */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="hidden sm:inline text-xs font-medium" style={{ color: (enabledState && !isComingSoon) ? 'var(--text-primary)' : 'var(--text-faint)' }}>
          {isComingSoon ? t('admin.addons.disabled') : enabledState ? t('admin.addons.enabled') : t('admin.addons.disabled')}
        </span>
        {!hideToggle && (
          <button
            onClick={() => !isComingSoon && onToggle(addon)}
            disabled={isComingSoon}
            className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
            style={{ background: (enabledState && !isComingSoon) ? 'var(--text-primary)' : 'var(--border-primary)', cursor: isComingSoon ? 'not-allowed' : 'pointer' }}
          >
            <span
              className="inline-block h-4 w-4 transform rounded-full transition-transform"
              style={{
                background: 'var(--bg-card)',
                transform: (enabledState && !isComingSoon) ? 'translateX(22px)' : 'translateX(4px)',
              }}
            />
          </button>
        )}
      </div>
    </div>
  )
}
