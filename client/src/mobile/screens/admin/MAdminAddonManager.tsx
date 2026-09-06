import { useEffect, useState, type ComponentType } from 'react'
import { adminApi } from '../../../api/client'
import { useTranslation } from '../../../i18n'
import { useSettingsStore } from '../../../store/settingsStore'
import { useAddonStore } from '../../../store/addonStore'
import { useToast } from '../../../components/shared/Toast'
import {
  Puzzle, ListChecks, Wallet, FileText, CalendarDays, Globe, Briefcase, Image, Terminal, Link2, Compass, BookOpen,
  MessageCircle, StickyNote, BarChart3, Sparkles, Luggage, Plane, Server, Cloud, Bookmark, Check, Loader2,
} from 'lucide-react'
import MToggle from '../../components/MToggle'
import { MAdminButton, MAdminCard, MAdminField, MAdminInput, MAdminSecretInput } from './MAdminUi'

const ICON_MAP = {
  ListChecks, Wallet, FileText, CalendarDays, Puzzle, Globe, Briefcase, Image, Terminal, Link2, Compass, BookOpen, Plane, Bookmark,
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

const PROVIDER_ICONS: Record<string, ComponentType<{ size?: number }>> = {
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

function AddonIcon({ name, size = 18 }: AddonIconProps) {
  const Icon = ICON_MAP[name] || Puzzle
  return <Icon size={size} />
}

interface CollabFeatures { chat: boolean; notes: boolean; links?: boolean; polls: boolean; whatsnext: boolean }

const COLLAB_SUB_FEATURES = [
  { key: 'chat', icon: MessageCircle, titleKey: 'admin.collab.chat.title', subtitleKey: 'admin.collab.chat.subtitle' },
  { key: 'notes', icon: StickyNote, titleKey: 'admin.collab.notes.title', subtitleKey: 'admin.collab.notes.subtitle' },
  { key: 'links', icon: Link2, titleKey: 'collab.tabs.links', subtitleKey: 'collab.links.empty' },
  { key: 'polls', icon: BarChart3, titleKey: 'admin.collab.polls.title', subtitleKey: 'admin.collab.polls.subtitle' },
  { key: 'whatsnext', icon: Sparkles, titleKey: 'admin.collab.whatsnext.title', subtitleKey: 'admin.collab.whatsnext.subtitle' },
] as const

export default function MAdminAddonManager({ bagTrackingEnabled, onToggleBagTracking, collabFeatures, onToggleCollabFeature }: { bagTrackingEnabled?: boolean; onToggleBagTracking?: () => void; collabFeatures?: CollabFeatures; onToggleCollabFeature?: (key: string) => void }) {
  const { t } = useTranslation()
  const dm = useSettingsStore(s => s.settings.dark_mode)
  const dark = dm === true || dm === 'dark' || (dm === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const toast = useToast()
  const refreshGlobalAddons = useAddonStore(s => s.loadAddons)
  const [addons, setAddons] = useState<Addon[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadAddons().finally(() => setLoading(false))
  }, [])

  const loadAddons = async () => {
    try {
      const data = await adminApi.addons()
      setAddons(data.addons)
    } catch (err: unknown) {
      toast.error(t('admin.addons.toast.error'))
    }
  }

  const handleToggle = async (addon: Addon) => {
    const newEnabled = !addon.enabled
    // Optimistic update
    setAddons(prev => prev.map(a => a.id === addon.id ? { ...a, enabled: newEnabled } : a))
    try {
      await adminApi.updateAddon(addon.id, { enabled: newEnabled })
    } catch (err: unknown) {
      // Rollback
      setAddons(prev => prev.map(a => a.id === addon.id ? { ...a, enabled: !newEnabled } : a))
      toast.error(t('admin.addons.toast.error'))
      return
    }
    refreshGlobalAddons()
    // Journey off disables every photo provider with it, and the response carries
    // only Journey. Without re-reading, switching Journey back on brings the shelf
    // up with providers the database has long since turned off.
    if (addon.id === 'journey') await loadAddons()
    toast.success(t('admin.addons.toast.updated'))
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

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 size={22} className="animate-spin text-m-faint" />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <MAdminCard>
        <div className="text-[0.875rem] font-extrabold text-m-ink">{t('admin.addons.title')}</div>
        <p className="mt-[2px] flex flex-wrap items-center gap-1 font-geist text-[0.625rem] leading-relaxed text-m-muted">
          {t('admin.addons.subtitleBefore')}
          <img src={dark ? '/text-light.svg' : '/text-dark.svg'} alt="TREK" style={{ height: 11, display: 'inline', verticalAlign: 'middle', opacity: 0.7 }} />
          {t('admin.addons.subtitleAfter')}
        </p>
      </MAdminCard>

      {addons.length === 0 ? (
        <MAdminCard>
          <p className="py-6 text-center font-geist text-[0.6875rem] text-m-faint">
            {t('admin.addons.noAddons')}
          </p>
        </MAdminCard>
      ) : (
        <>
          {/* Trip Addons */}
          {tripAddons.length > 0 && (
            <MAdminCard>
              <MGroupHead icon={Briefcase} label={`${t('admin.addons.type.trip')} — ${t('admin.addons.tripHint')}`} />
              {tripAddons.map((addon, i) => (
                <div key={addon.id}>
                  <MAddonRow addon={addon} onToggle={handleToggle} t={t} first={i === 0} />
                  {addon.id === 'packing' && addon.enabled && onToggleBagTracking && (
                    <MSubRow
                      icon={Luggage}
                      title={t('admin.bagTracking.title')}
                      subtitle={t('admin.bagTracking.subtitle')}
                      enabled={!!bagTrackingEnabled}
                      onToggle={onToggleBagTracking}
                    />
                  )}
                  {addon.id === 'collab' && addon.enabled && collabFeatures && onToggleCollabFeature && (
                    <>
                      {COLLAB_SUB_FEATURES.map(feat => (
                        <MSubRow
                          key={feat.key}
                          icon={feat.icon}
                          title={t(feat.titleKey)}
                          subtitle={t(feat.subtitleKey)}
                          enabled={collabFeatures[feat.key]}
                          onToggle={() => onToggleCollabFeature(feat.key)}
                        />
                      ))}
                    </>
                  )}
                </div>
              ))}
            </MAdminCard>
          )}

          {/* Global Addons */}
          {globalAddons.length > 0 && (
            <MAdminCard>
              <MGroupHead icon={Globe} label={`${t('admin.addons.type.global')} — ${t('admin.addons.globalHint')}`} />
              {globalAddons.map((addon, i) => (
                <div key={addon.id}>
                  <MAddonRow addon={addon} onToggle={handleToggle} t={t} first={i === 0} />
                  {/* Memories providers as sub-items under Journey addon — only while it is on */}
                  {addon.id === 'journey' && addon.enabled && providerOptions.length > 0 && (
                    <>
                      {providerOptions.map(provider => {
                        const ProviderIcon = PROVIDER_ICONS[provider.key]
                        return (
                          <MSubRow
                            key={provider.key}
                            providerIcon={ProviderIcon}
                            title={provider.label}
                            subtitle={provider.description}
                            enabled={provider.enabled}
                            onToggle={provider.toggle}
                          />
                        )
                      })}
                    </>
                  )}
                </div>
              ))}
            </MAdminCard>
          )}

          {/* Integration Addons */}
          {integrationAddons.length > 0 && (
            <MAdminCard>
              <MGroupHead icon={Link2} label={`${t('admin.addons.type.integration')} — ${t('admin.addons.integrationHint')}`} />
              {integrationAddons.map((addon, i) => (
                <div key={addon.id}>
                  <MAddonRow addon={addon} onToggle={handleToggle} t={t} first={i === 0} />
                  {addon.id === 'llm_parsing' && addon.enabled && (
                    <div className="mt-1 border-t border-[color:var(--m-rowbr)] pt-3">
                      <LlmParsingConfig addon={addon} />
                    </div>
                  )}
                </div>
              ))}
            </MAdminCard>
          )}
        </>
      )}
    </div>
  )
}

/** Group subheader: small icon + uppercase label, matches the desktop section band. */
function MGroupHead({ icon: Icon, label }: { icon: typeof Briefcase; label: string }) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <Icon size={13} className="flex-none text-m-muted" />
      <span className="font-geist text-[0.625rem] font-bold uppercase tracking-[0.06em] text-m-muted">{label}</span>
    </div>
  )
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

interface MAddonRowProps {
  addon: Addon
  onToggle: (addon: Addon) => void
  t: (key: string) => string
  first?: boolean
}

/** Addon row: icon tile, name + type badge, description, MToggle. */
function MAddonRow({ addon, onToggle, t, first }: MAddonRowProps) {
  const label = getAddonLabel(t, addon)
  const typeLabel =
    addon.type === 'global' ? t('admin.addons.type.global') : addon.type === 'integration' ? t('admin.addons.type.integration') : t('admin.addons.type.trip')
  return (
    <div className={`flex items-center gap-3 py-[11px] ${first ? '' : 'border-t border-[color:var(--m-rowbr)]'}`}>
      <span className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[11px] bg-[color:var(--m-ic)] text-m-ink">
        <AddonIcon name={addon.icon} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-[0.8125rem] font-bold text-m-ink">{label.name}</span>
          <span className="flex-none rounded-full bg-[color:var(--m-ic)] px-[7px] py-[2px] font-geist text-[0.5625rem] font-bold text-m-muted">
            {typeLabel}
          </span>
        </div>
        <p className="mt-[1px] font-geist text-[0.625rem] leading-relaxed text-m-muted">{label.description}</p>
      </div>
      <MToggle checked={addon.enabled} ariaLabel={label.name} onChange={() => onToggle(addon)} />
    </div>
  )
}

interface MSubRowProps {
  icon?: typeof Luggage
  providerIcon?: ComponentType<{ size?: number }>
  title: string
  subtitle: string
  enabled: boolean
  onToggle: () => void
}

/** Indented sub-feature row (bag tracking, collab features, memory providers). */
function MSubRow({ icon: Icon, providerIcon: ProviderIcon, title, subtitle, enabled, onToggle }: MSubRowProps) {
  return (
    <div className="flex items-center gap-3 border-t border-[color:var(--m-rowbr)] py-[9px] pl-[50px]">
      <span className="flex-none text-m-faint">
        {Icon ? <Icon size={14} /> : ProviderIcon ? <ProviderIcon size={14} /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[0.75rem] font-bold text-m-ink">{title}</div>
        <div className="mt-[1px] font-geist text-[0.59375rem] leading-relaxed text-m-muted">{subtitle}</div>
      </div>
      <MToggle checked={enabled} ariaLabel={title} onChange={onToggle} />
    </div>
  )
}

const MASKED = '••••••••'
const DEFAULT_OLLAMA_URL = 'http://localhost:11434/v1'

/** Curated models the local extractor is tuned for, pullable via Ollama. The router drives
 *  one model per document via Ollama's grammar-constrained `format`; "thinking" is disabled
 *  automatically, so the Qwen3 family works without any tuning. A host only needs one. */
const RECOMMENDED_MODELS: { id: string; label: string; note: string; recommended: boolean; vision: boolean }[] = [
  { id: 'qwen3:8b', label: 'Qwen3 — 8B', note: 'Recommended · best extraction quality & speed on CPU (thinking auto-disabled) · Apache-2.0', recommended: true, vision: false },
]

/**
 * Instance-wide AI-parsing config. When set, applies to the whole instance and
 * overrides per-user config (see server llmConfig.ts). The API key is masked on
 * read; an unchanged mask is treated as a no-op by the server. For the local
 * provider, it also lists installed Ollama models and can pull NuExtract models.
 */
function LlmParsingConfig({ addon }: { addon: Addon }) {
  const toast = useToast()
  const cfg = (addon.config ?? {}) as Record<string, unknown>
  const [provider, setProvider] = useState<string>((cfg.provider as string) ?? 'local')
  const [model, setModel] = useState<string>((cfg.model as string) ?? '')
  const [baseUrl, setBaseUrl] = useState<string>((cfg.baseUrl as string) ?? '')
  const [apiKey, setApiKey] = useState<string>((cfg.apiKey as string) ?? '')
  const [saving, setSaving] = useState(false)

  // Local-provider model management.
  const [installed, setInstalled] = useState<string[]>([])
  const [modelsErr, setModelsErr] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [pulling, setPulling] = useState<string | null>(null)
  const [pullPct, setPullPct] = useState(0)
  const [pullStatus, setPullStatus] = useState('')

  const effectiveUrl = baseUrl.trim() || DEFAULT_OLLAMA_URL
  const isInstalled = (id: string) => installed.some(n => n === id || n.startsWith(id + ':') || n.startsWith(id))

  const loadModels = async () => {
    if (provider !== 'local') return
    setLoadingModels(true)
    setModelsErr('')
    try {
      const res = await adminApi.llmLocalModels(effectiveUrl)
      setInstalled(res.models.map(m => m.name))
    } catch (e: unknown) {
      setModelsErr(e instanceof Error ? e.message : 'Could not reach the local LLM server')
      setInstalled([])
    } finally {
      setLoadingModels(false)
    }
  }

  // Load installed models when the local provider is active.
  useEffect(() => {
    if (provider === 'local') loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider])

  const pull = async (id: string) => {
    if (pulling) return
    setPulling(id)
    setPullPct(0)
    setPullStatus('starting…')
    try {
      await adminApi.llmLocalPull(effectiveUrl, id, (p) => {
        if (p.error) throw new Error(p.error)
        if (p.status) setPullStatus(p.status)
        if (p.total && p.completed != null) setPullPct(Math.round((p.completed / p.total) * 100))
      })
      toast.success('Model pulled')
      setModel(id)
      await loadModels()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Pull failed')
    } finally {
      setPulling(null)
      setPullPct(0)
      setPullStatus('')
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      // Send the masked sentinel unchanged so the server keeps the stored key.
      await adminApi.updateAddon(addon.id, { config: { provider, model: model.trim(), baseUrl: baseUrl.trim(), apiKey, multimodal: cfg.multimodal === true } })
      toast.success('Saved')
    } catch {
      toast.error('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const sectionCls = 'font-geist text-[0.625rem] font-bold uppercase tracking-[0.06em] text-m-faint'

  const providerOptions = [
    { value: 'local', label: 'Local · OpenAI-compatible', icon: <Server size={14} />, badge: 'Ollama' },
    { value: 'openai', label: 'OpenAI', icon: <Cloud size={14} /> },
    { value: 'anthropic', label: 'Anthropic', icon: <Sparkles size={14} /> },
  ]

  return (
    <div className="space-y-5 pl-[50px]">
      <p className="font-geist text-[0.625rem] leading-relaxed text-m-faint">
        Set instance-wide config (applies to all users). Leave blank to let each user configure their own provider.
      </p>

      {/* Connection */}
      <section className="space-y-3">
        <div className={sectionCls}>Connection</div>
        <MAdminField label="Provider">
          <div className="space-y-[6px]">
            {providerOptions.map((opt) => {
              const active = provider === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setProvider(opt.value)}
                  className={`flex w-full items-center gap-2 rounded-xl border px-3 py-[10px] text-left ${
                    active ? 'border-[color:var(--m-act)] bg-[color:var(--m-ic)]' : 'border-[color:var(--m-rowbr)]'
                  }`}
                >
                  <span className="flex-none text-m-muted">{opt.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold text-m-ink">{opt.label}</span>
                  {opt.badge && (
                    <span className="flex-none rounded-full bg-[color:var(--m-ic)] px-2 py-[2px] font-geist text-[0.5625rem] font-bold text-m-muted">
                      {opt.badge}
                    </span>
                  )}
                  {active && <Check size={15} strokeWidth={2.4} className="flex-none text-m-ink" />}
                </button>
              )
            })}
          </div>
        </MAdminField>
        {provider !== 'anthropic' && (
          <MAdminField label="Base URL">
            <MAdminInput
              type="url"
              autoComplete="off"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              onBlur={loadModels}
              placeholder={provider === 'local' ? 'http://localhost:11434/v1' : 'https://api.openai.com/v1'}
            />
          </MAdminField>
        )}
        <MAdminField label="API key">
          <MAdminSecretInput
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={apiKey === MASKED ? MASKED : provider === 'local' ? '(often not required)' : 'sk-…'}
          />
        </MAdminField>
        {provider === 'anthropic' && (
          <p className="font-geist text-[0.625rem] leading-relaxed text-m-faint">
            Anthropic reads PDFs (including scans) natively. Local/OpenAI models receive extracted text — scanned PDFs need Anthropic.
          </p>
        )}
      </section>

      {/* Model */}
      <section className="space-y-3">
        <div className={sectionCls}>Model</div>
        <MAdminInput
          autoComplete="off"
          value={model}
          onChange={e => setModel(e.target.value)}
          placeholder={provider === 'anthropic' ? 'claude-opus-4-8' : provider === 'openai' ? 'gpt-4o' : 'select or pull below'}
        />

        {/* Local model management (Ollama) */}
        {provider === 'local' && (
          <div className="space-y-3 rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] p-3">
            <div className="flex items-center justify-between">
              <span className="text-[0.75rem] font-semibold text-m-ink">Installed on the server</span>
              <button
                type="button"
                onClick={loadModels}
                disabled={loadingModels}
                className="font-geist text-[0.6875rem] text-m-muted underline disabled:opacity-60"
              >
                {loadingModels ? 'Loading…' : 'Refresh'}
              </button>
            </div>
            {modelsErr && <p className="font-geist text-[0.6875rem] text-[color:var(--m-st-danger)]">{modelsErr}</p>}
            {!modelsErr && installed.length === 0 && !loadingModels && (
              <p className="font-geist text-[0.6875rem] text-m-faint">No models installed yet — pull one below.</p>
            )}
            {installed.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {installed.map(name => (
                  <button
                    key={name}
                    type="button"
                    title={name}
                    onClick={() => setModel(name)}
                    className={`max-w-full truncate rounded-full border px-[10px] py-[5px] text-[0.6875rem] ${
                      model === name ? 'border-transparent bg-m-act text-m-actfg' : 'border-[color:var(--m-rowbr)] text-m-ink'
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}

            <div className="border-t border-[color:var(--m-rowbr)] pt-3">
              <div className="mb-2 text-[0.75rem] font-semibold text-m-ink">Pull a recommended model</div>
              <div className="space-y-1">
                {RECOMMENDED_MODELS.map(m => {
                  const installedHere = isInstalled(m.id)
                  const isPulling = pulling === m.id
                  const active = model === m.id
                  return (
                    <div
                      key={m.id}
                      className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${
                        active ? 'border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)]' : 'border-transparent'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[0.8125rem] text-m-ink">{m.label}</span>
                          {m.recommended && (
                            <span className="rounded-md bg-[color:color-mix(in_srgb,var(--m-st-confirmed)_15%,transparent)] px-1.5 py-px font-geist text-[0.5625rem] font-bold text-[color:var(--m-st-confirmed)]">
                              Recommended
                            </span>
                          )}
                        </div>
                        <div className="font-geist text-[0.625rem] leading-relaxed text-m-faint">{m.note}</div>
                        {isPulling && (
                          <div className="mt-1.5">
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--m-ic)]">
                              <div className="h-full bg-m-act transition-[width] duration-200" style={{ width: `${pullPct}%` }} />
                            </div>
                            <div className="mt-0.5 font-geist text-[0.5625rem] text-m-faint">{pullStatus}{pullPct ? ` · ${pullPct}%` : ''}</div>
                          </div>
                        )}
                      </div>
                      {installedHere ? (
                        <MAdminButton variant="ghost" disabled={active} onClick={() => setModel(m.id)}>
                          {active ? 'Selected' : 'Use'}
                        </MAdminButton>
                      ) : (
                        <MAdminButton busy={isPulling} disabled={!!pulling} onClick={() => pull(m.id)}>
                          {isPulling ? 'Pulling…' : 'Pull'}
                        </MAdminButton>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </section>

      <MAdminButton busy={saving} onClick={save}>
        {saving ? 'Saving…' : 'Save'}
      </MAdminButton>
    </div>
  )
}
