import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { PLUGIN_PERMISSIONS } from '@trek/shared'
import { createPortal } from 'react-dom'
import {
  Blocks, AlertTriangle, PackageOpen, RefreshCw, Trash2, Download, Bug, X, ShieldCheck, UploadCloud,
  ArrowUpCircle, Github, ExternalLink, ChevronDown, Check, Lock, Search, Link2, KeyRound, ShieldAlert,
  SlidersHorizontal, ArrowUpDown, CircleDot, MoreHorizontal, RotateCw, ArrowRight, Database, Users, LayoutDashboard,
  Radio, Luggage, Globe, Image, CalendarDays, Bell, Info, History, PauseCircle,
  Wallet, Puzzle, MapPin, ListChecks, Pencil, Tag, FileText, Route, Navigation, Clock, LocateFixed, Palette, Bot,
  Loader2,
} from 'lucide-react'
import PluginIcon from '../shared/PluginIcon'
import { adminApi } from '../../api/client'
import { useInstanceSettings } from './useInstanceSettings'
import { bypassChip, bypassOffer, useRangeBypass, type RangeWarning, type TrekRangeBypass } from './useRangeBypass'
import { usePluginStore } from '../../store/pluginStore'
import { useTranslation } from '../../i18n'
import { useToast } from '../shared/Toast'
import ConfirmDialog from '../shared/ConfirmDialog'
import ToggleSwitch from '../Settings/ToggleSwitch'

/**
 * Admin → Plugins (#plugins). A full plugin-management surface: a segmented
 * Installed/Discover switch, a toolbar (search + type/status filters + sort), an
 * updates bar, tidy installed rows that surface each plugin's real reach as
 * capability chips, an App-Store-style registry grid, an enriched detail dialog,
 * and the update re-consent gate. Isolation health shows as a dot on the icon
 * tile; the security section at the bottom explains the model honestly.
 */

interface PluginDep { id: string; version: string }
interface VersionMismatch { id: string; wanted: string; installed: string }
type DependencyStatus = 'ok' | 'addonDisabled' | 'missingPlugin' | 'hostIncompatible'
interface PluginDependencies { requiredAddons: string[]; pluginDependencies: PluginDep[] }
interface DependencyIssues { disabledAddons: string[]; missing: PluginDep[]; versionMismatch: VersionMismatch[] }

interface PluginRow {
  id: string
  name: string
  description: string | null
  type: string
  icon: string | null
  version: string | null
  status: string
  enabled: number
  last_error: string | null
  reviewed_at: string | null
  source_repo: string | null
  permissions: string
  capabilities: string
  /** The plugin needs OPERATOR-supplied egress hosts (a self-hosted target). */
  operatorEgress?: boolean
  /** How many hosts the admin has added — 0 means the plugin can't reach anything yet. */
  egressHostCount?: number
  /** How many `scope:'instance'` settings fields the plugin declares — gates the
   * "Instance settings" menu item without a per-plugin fetch. */
  instanceSettingsCount?: number
  /** How many `scope:'instance'` actions the plugin declares — a plugin with actions
   * but no settings fields still needs the menu item to run them. */
  instanceActionsCount?: number
  dependencies?: PluginDependencies
  dependencyStatus?: DependencyStatus
  dependencyIssues?: DependencyIssues
  /** The TREK versions the plugin says it supports; null if it never declared any. */
  trekRange?: string | null
  /** The TREK this server is running — the server does the semver, the client just shows it. */
  hostVersion?: string
  /** Non-null while the plugin runs outside its declared range on the operator's say-so. */
  trekRangeBypassed?: TrekRangeBypass | null
  /** The author's signature was verified and their key pinned at install. False means the
   * bytes matched the registry's sha256 and nothing more — one fewer guarantee. */
  signed?: boolean
  /** Short form of the pinned key, for eyeballing against what the author reads out. */
  keyFingerprint?: string | null
  /** Why an update was refused, if one was. `version` is the version that was refused. */
  updateBlock?: { code: string; detail: string | null; version: string | null } | null
  /** A deliberate non-latest install paused updates: out of the banner/Update all until resumed. */
  updateHold?: boolean
}
interface RegistryItem {
  id: string
  name: string
  author: string
  description: string
  repo: string
  homepage?: string | null
  type: string
  /** Lucide icon name from the registry entry; absent → Blocks. */
  icon?: string | null
  latest: string | null
  minTrekVersion: string | null
  /** The latest version's declared TREK range; null on a legacy registry entry. */
  trek?: string | null
  hostVersion?: string
  /** Whether the LATEST version can be installed on this TREK. Computed server-side. */
  compatible?: boolean
  /** Newest installable version — the latest, an older fallback, or null if none fits. */
  latestCompatible?: string | null
  reviewedAt: string | null
  downloadCount?: number | null
  screenshotUrl: string | null
  requiredAddons?: string[]
  pluginDependencies?: PluginDep[]
  /** The latest version ships an author signature and the entry declares a key. */
  signed?: boolean
  /** The full key — public, and carried in full because re-trust compares it exactly. */
  authorPublicKey?: string | null
}
/** One published version, with its SERVER-computed compat verdict (the client has no semver). */
interface VersionInfo {
  version: string
  publishedAt: string | null
  size: number | null
  signed: boolean
  /** The declared TREK requirement, or null when the entry carries no bounds at all. */
  trek: string | null
  compatible: boolean
}
interface RegistryDetail extends RegistryItem {
  size: number | null
  publishedAt: string | null
  /** Every published version, newest first — the version picker's data. */
  versions?: VersionInfo[]
  manifest: {
    // Optional because a registry may omit an empty list — the detail view has to
    // degrade rather than throw halfway through its render.
    permissions?: string[]
    egress?: string[]
    /** The plugin needs OPERATOR-supplied hosts — its egress list is not the whole story. */
    operatorEgress?: boolean
    settings?: Array<{ key: string; label: string; inputType: string; scope: string; required: boolean }>
    license: string | null
    icon: string | null
    requiredAddons?: string[]
    pluginDependencies?: PluginDep[]
    /** Display slice of the manifest's capabilities — drives the same chips as an installed row. */
    capabilities?: {
      widget?: { slot?: string }
      tripPage?: { replaces?: string[] }
      /** Tools the plugin will publish on the MCP server once mcp:tools is granted. */
      mcpTools?: Array<{ name: string; title?: string; description: string }>
    }
  } | null
}

/** 409 error-body shape from POST /activate when a dependency blocks activation. */
interface ActivateErr {
  response?: {
    status?: number
    data?: { code?: string; error?: string; newPermissions?: string[]; newEgress?: string[]; addons?: string[]; missing?: PluginDep[]; versionMismatch?: VersionMismatch[] }
  }
}

/** The server's error envelope. Reading `code` — not the message text — is what lets the
 * UI tell a rotated key (overridable) from a signature that doesn't verify (never). */
function errBody(e: unknown): { error?: string; code?: string } {
  return (e as { response?: { data?: { error?: string; code?: string } } })?.response?.data ?? {}
}

/** The ONE signature refusal an admin may override, because a rotation has a benign
 * explanation. SIGNATURE_INVALID / _MISSING / _INCOMPLETE mean the bytes are not what the
 * author signed — those get an explanation and no override button at all. */
const RETRUSTABLE = 'SIGNATURE_KEY_CHANGED'
const SIGNATURE_CODES = [RETRUSTABLE, 'SIGNATURE_INVALID', 'SIGNATURE_MISSING', 'SIGNATURE_INCOMPLETE']

/**
 * What the signature dialog needs to talk about a plugin — deliberately NOT a PluginRow.
 *
 * A refusal can land on a plugin that is not installed (a fresh install from Discover, or a
 * dependency being downloaded), and those have no row. Keying the dialog off PluginRow meant
 * the lookup missed and the refusal silently degraded to a toast — on the very path where an
 * admin most often meets these codes for the first time. Name + pinned fingerprint is all the
 * dialog ever reads, and both a row and a registry entry can supply that.
 */
type SigSubject = { id: string; name: string; keyFingerprint: string | null }

/**
 * Is a recorded update block still describing the version on offer?
 *
 * Once the registry offers something NEWER than the version that was refused, the block
 * describes an artifact nobody is being offered anymore — so it reads as stale and the
 * admin can simply re-attempt (the next install re-verifies and either succeeds or
 * re-blocks with fresh values). When the registry is unreachable we can't prove staleness,
 * so the block stands: silently dropping the last thing we knew would be the worse failure.
 */
function blockIsCurrent(p: PluginRow, latestVer?: string): boolean {
  if (!p.updateBlock) return false
  // A block describes a refused REGISTRY update. Once a plugin is sideloaded or dev-linked
  // it has left the registry trust model — the running code is whatever the admin supplied,
  // and a block about an author signing key says nothing about it. The server clears the
  // block on both paths; this makes it impossible to render a stale one regardless.
  if (!isRegistrySourced(p.source_repo)) return false
  if (!latestVer || !p.updateBlock.version) return true
  return latestVer === p.updateBlock.version
}

type T = (k: string, p?: Record<string, unknown>) => string
type TypeFilter = 'all' | 'widget' | 'page' | 'integration' | 'trip-page'
type StatusFilter = 'all' | 'on' | 'off' | 'update' | 'err'
type SortKey = 'name' | 'recent' | 'updates' | 'downloads'

// Runtime health → dot colour on the icon tile.
const HEALTH: Record<string, string> = {
  active: 'bg-success',
  starting: 'bg-info animate-pulse',
  error: 'bg-danger',
  inactive: 'bg-content-faint/60',
  disabled: 'bg-warning',
  incompatible: 'bg-warning',
}

// Known permissions → human-readable i18n key; unknown ones render as raw code.
// Generated from the host's protocol/envelope.ts by
// server/scripts/gen-plugin-facts.ts - this used to be a hand-kept fourth copy.
const PERM_KEYS = PLUGIN_PERMISSIONS

const KNOWN_TYPES = ['widget', 'page', 'integration', 'trip-page']

function isNewer(a: string, b: string): boolean {
  const nums = (v: string) => v.split('-')[0].split('.').map(n => Number.parseInt(n, 10) || 0)
  const pa = nums(a), pb = nums(b)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x !== y) return x > y
  }
  return !a.includes('-') && b.includes('-')
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  try { const v = JSON.parse(raw || '') as T; return v ?? fallback } catch { return fallback }
}

interface Cap { icon: React.ComponentType<{ size?: number; className?: string }>; label: string; net?: boolean }

// Turn a plugin's declared permissions + capabilities into the at-a-glance chips
// that make its real reach legible without opening the detail dialog.
function deriveCaps(perms: string[], caps: { widget?: { slot?: string }; tripPage?: { replaces?: string[] } }, t: T): Cap[] {
  const out: Cap[] = []
  if (perms.includes('db:read:trips')) out.push({ icon: Database, label: t('admin.plugins.cap.readsTrips') })
  if (perms.includes('db:read:users')) out.push({ icon: Users, label: t('admin.plugins.cap.readsUsers') })
  if (perms.includes('db:write:costs')) out.push({ icon: Wallet, label: t('admin.plugins.cap.writesCosts') })
  else if (perms.includes('db:read:costs')) out.push({ icon: Wallet, label: t('admin.plugins.cap.readsCosts') })
  if (perms.includes('db:read:packing')) out.push({ icon: Luggage, label: t('admin.plugins.cap.readsPacking') })
  if (perms.includes('db:read:files')) out.push({ icon: FileText, label: t('admin.plugins.cap.readsFiles') })
  if (perms.includes('db:write:places')) out.push({ icon: MapPin, label: t('admin.plugins.cap.writesPlaces') })
  if (perms.includes('db:write:days')) out.push({ icon: CalendarDays, label: t('admin.plugins.cap.writesDays') })
  if (perms.includes('db:write:itinerary')) out.push({ icon: ListChecks, label: t('admin.plugins.cap.writesItinerary') })
  if (perms.includes('db:write:trips')) out.push({ icon: Pencil, label: t('admin.plugins.cap.writesTrips') })
  if (perms.includes('db:meta')) out.push({ icon: Tag, label: t('admin.plugins.cap.metadata') })
  if (caps.widget) {
    const slotKey = caps.widget.slot === 'hero' ? 'admin.plugins.cap.heroWidget'
      : caps.widget.slot === 'place-detail' ? 'admin.plugins.cap.placeSlot'
      : caps.widget.slot === 'day-detail' ? 'admin.plugins.cap.daySlot'
      : caps.widget.slot === 'reservation-detail' ? 'admin.plugins.cap.reservationSlot'
      : 'admin.plugins.cap.widget'
    out.push({ icon: LayoutDashboard, label: t(slotKey as never) })
  }
  // Replacing planner tabs is the one capability that HIDES core UI — always chip it.
  if (caps.tripPage?.replaces?.length) out.push({ icon: LayoutDashboard, label: t('admin.plugins.cap.replacesTabs') })
  if (perms.includes('mcp:tools')) out.push({ icon: Bot, label: t('admin.plugins.cap.mcpTools') })
  if (perms.some(p => p.startsWith('ws:broadcast'))) out.push({ icon: Radio, label: t('admin.plugins.cap.realtime') })
  if (perms.includes('hook:photo-provider')) out.push({ icon: Image, label: t('admin.plugins.cap.photos') })
  if (perms.includes('hook:calendar-source')) out.push({ icon: CalendarDays, label: t('admin.plugins.cap.calendar') })
  if (perms.includes('hook:place-detail-provider')) out.push({ icon: MapPin, label: t('admin.plugins.cap.placeDetails') })
  if (perms.includes('hook:trip-warning-provider')) out.push({ icon: AlertTriangle, label: t('admin.plugins.cap.warnings') })
  if (perms.includes('hook:map-layer-provider')) out.push({ icon: Route, label: t('admin.plugins.cap.mapLayers') })
  if (perms.includes('hook:route-provider')) out.push({ icon: Navigation, label: t('admin.plugins.cap.routing') })
  if (perms.includes('hook:day-schedule-provider')) out.push({ icon: Clock, label: t('admin.plugins.cap.daySchedule') })
  if (perms.includes('hook:day-tint-provider')) out.push({ icon: Palette, label: t('admin.plugins.cap.dayTint') })
  if (perms.includes('geolocation:read')) out.push({ icon: LocateFixed, label: t('admin.plugins.cap.geolocation') })
  if (perms.includes('hook:notification-channel')) out.push({ icon: Bell, label: t('admin.plugins.cap.notificationChannel') })
  if (perms.includes('events:subscribe')) out.push({ icon: Radio, label: t('admin.plugins.cap.events') })
  for (const h of perms.filter(p => p.startsWith('http:outbound:')).map(p => p.slice('http:outbound:'.length)).filter(Boolean)) {
    out.push({ icon: ArrowRight, label: h, net: true })
  }
  return out
}

interface DepChip { icon: React.ComponentType<{ size?: number; className?: string }>; label: string; blocked: boolean; warn?: boolean }

// A plugin's declared dependencies as chips — a required addon (amber when that
// addon is disabled), a plugin dependency (amber when missing / version-mismatched),
// or the TREK version itself (amber when this server has outgrown the plugin's range,
// which is the one blocker the admin cannot fix by flipping something else on).
function deriveDeps(p: PluginRow, t: T): DepChip[] {
  const out: DepChip[] = []
  const issues = p.dependencyIssues
  if (p.dependencyStatus === 'hostIncompatible') {
    out.push({
      icon: AlertTriangle,
      label: p.trekRange
        ? t('admin.plugins.dep.trekIncompatible', { range: p.trekRange, host: p.hostVersion ?? '?' })
        : t('admin.plugins.dep.trekUnknown'),
      blocked: true,
    })
  }
  const bypassed = bypassChip(p.trekRangeBypassed, t) // TREK_PLUGINS_IGNORE_TREK_RANGE: a warning, not a blocker
  if (bypassed) out.push(bypassed)
  for (const a of p.dependencies?.requiredAddons ?? []) {
    out.push({ icon: Blocks, label: t('admin.plugins.cap.requiresAddon', { addon: a }), blocked: !!issues?.disabledAddons.includes(a) })
  }
  for (const d of p.dependencies?.pluginDependencies ?? []) {
    const blocked = !!(issues?.missing.some(m => m.id === d.id) || issues?.versionMismatch.some(m => m.id === d.id))
    out.push({ icon: Puzzle, label: t('admin.plugins.cap.dependsOn', { id: d.id, version: d.version }), blocked })
  }
  return out
}

/**
 * What the Install button may do for a registry item.
 *
 * The server already decided compatibility — it owns the semver, and a second
 * implementation here would eventually disagree with the install gate and offer a button
 * that 400s. This only picks the wording. Note the middle case: when the newest release
 * has outrun this TREK but an older one still fits, offer THAT version rather than a dead
 * grey button. The plugin is perfectly usable, just not at its newest.
 */
function installOffer(item: RegistryItem, t: T, ignoreTrekRange = false): { blocked: boolean; version?: string; label: string; title?: string; warn?: RangeWarning } {
  if (item.compatible !== false) return { blocked: false, label: t('admin.plugins.install') }
  const title = item.trek
    ? t('admin.plugins.dep.trekIncompatible', { range: item.trek, host: item.hostVersion ?? '?' })
    : t('admin.plugins.dep.trekUnknown')
  if (ignoreTrekRange) return bypassOffer(item, t, title) // TREK_PLUGINS_IGNORE_TREK_RANGE: "Install anyway"
  if (item.latestCompatible) {
    return { blocked: false, version: item.latestCompatible, label: t('admin.plugins.installCompatible', { version: item.latestCompatible }), title }
  }
  return { blocked: true, label: t('admin.plugins.incompatible'), title }
}

function ReviewedBadge({ t }: { t: T }) {
  return <ShieldCheck size={13} className="text-success shrink-0" aria-label={t('admin.plugins.reviewed')} />
}

/** Marks a manually-uploaded (sideloaded) plugin: no registry, unsigned, not reviewed. */
function SideloadedBadge({ t }: { t: T }) {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-[2px] rounded-md text-[11px] font-medium bg-warning-soft text-warning border border-warning/25"
      title={t('admin.plugins.sideloadedHint')}>
      <UploadCloud size={11} /> {t('admin.plugins.sideloaded')}
    </span>
  )
}

/**
 * Whether a plugin came from the REGISTRY (as opposed to a manual upload or a dev-link).
 *
 * This is the precedence rule for the trust badges, and it is load-bearing: `signed`
 * derives from the pinned author key while sideloaded/dev-linked derive from source_repo,
 * so the states are NOT mutually exclusive in the data. A sideloaded plugin genuinely has
 * no pinned key, and a naive render would put "Unsigned" *and* "Sideloaded" side by side.
 * The source badge wins — it already says something strictly stronger, and doubling up
 * dilutes the amber into wallpaper, which is exactly what makes a warning worthless.
 */
function isRegistrySourced(sourceRepo: string | null | undefined): boolean {
  return !!sourceRepo && sourceRepo !== 'local:upload' && sourceRepo !== 'local:link'
}

/**
 * Signed / Unsigned, for registry plugins only (see isRegistrySourced).
 *
 * Signed is a quiet neutral tick, NOT a green celebration; unsigned is an amber note, NOT
 * a red alarm. Roughly two thirds of the live registry is unsigned, so an alarming
 * treatment would fire on most of the catalog and teach admins to ignore it — and the
 * honest delta is small: sha256 proves the bytes are what the REGISTRY vouches for, a
 * signature proves they came from the AUTHOR. Unsigned is one fewer guarantee, not "unsafe".
 */
function TrustBadge({ signed, t }: { signed: boolean; t: T }) {
  if (signed) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-[2px] rounded-md text-[11px] font-medium bg-surface-tertiary text-content-muted border border-edge-secondary"
        title={t('admin.plugins.signedHint')}>
        <KeyRound size={11} /> {t('admin.plugins.signed')}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-[2px] rounded-md text-[11px] font-medium bg-warning-soft text-warning border border-warning/25"
      title={t('admin.plugins.unsignedHint')}>
      <ShieldAlert size={11} /> {t('admin.plugins.unsigned')}
    </span>
  )
}

/** Marks a dev-linked plugin: loaded from a local build dir + hot-reloaded (dev only). */
function DevLinkBadge({ t }: { t: T }) {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-[2px] rounded-md text-[11px] font-medium bg-accent-soft text-accent border border-accent/25"
      title={t('admin.plugins.devLinkHint')}>
      <Link2 size={11} /> {t('admin.plugins.devLinkBadge')}
    </span>
  )
}

function TypeBadge({ type, t }: { type: string; t: T }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide bg-accent-subtle text-content-muted">
      {KNOWN_TYPES.includes(type) ? t(`admin.plugins.type.${type}` as never) : type}
    </span>
  )
}

export default function AdminPluginsPanel() {
  const { t, locale } = useTranslation()
  const toast = useToast()
  const [runtimeOn, setRuntimeOn] = useState(false)
  const [devLink, setDevLink] = useState(false) // dev-link enabled server-side (TREK_PLUGINS_DEV_LINK)
  const [ignoreTrekRange, setIgnoreTrekRange] = useState(false) // TREK_PLUGINS_IGNORE_TREK_RANGE set server-side
  const bypass = useRangeBypass() // its warning dialog/sheet state — shared with the other shell
  const [linkPath, setLinkPath] = useState('')
  const [plugins, setPlugins] = useState<PluginRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [view, setView] = useState<'installed' | 'discover'>('installed')
  const [registry, setRegistry] = useState<RegistryItem[] | null>(null)
  const [latest, setLatest] = useState<Record<string, string>>({})
  // The registry entry per id — the re-trust dialog needs the NEW author key from it (in
  // full: the server's equality check is exact), and the Discover/consent copy needs `signed`.
  const [regById, setRegById] = useState<Record<string, RegistryItem>>({})
  // Open when a signature check refused an install/update. Carries the code, so the dialog
  // knows whether an override may even be offered.
  const [signatureBlock, setSignatureBlock] = useState<{ subject: SigSubject; code: string; detail: string | null } | null>(null)
  const [retrusting, setRetrusting] = useState(false)
  const [detailFor, setDetailFor] = useState<RegistryItem | null>(null)
  const [errorsFor, setErrorsFor] = useState<{ id: string; rows: Array<{ ts: string; level: string; message: string }> } | null>(null)
  const [egressFor, setEgressFor] = useState<{ id: string; supported: boolean; hosts: string[] } | null>(null)
  // The admin-owned scope:'instance' settings form — shared logic with the phone shell.
  const settings = useInstanceSettings()
  const [egressDraft, setEgressDraft] = useState('')
  const [egressSaving, setEgressSaving] = useState(false)
  const [egressError, setEgressError] = useState('')
  const [confirmUninstall, setConfirmUninstall] = useState<PluginRow | null>(null)
  // The version picker for an INSTALLED plugin ("Change version…"); versions land async
  // from the registry detail endpoint, which computes each version's compat verdict.
  const [versionPicker, setVersionPicker] = useState<{ plugin: PluginRow; versions: VersionInfo[] | null; failed: boolean } | null>(null)
  // A picked version OLDER than the installed one — held here until the admin consents
  // to the data risk (the plugin's data dir stays; older code may not understand it).
  const [confirmDowngrade, setConfirmDowngrade] = useState<{ plugin: PluginRow; version: string } | null>(null)
  // A QUEUE, not one slot: "Update All" can produce several re-consent prompts —
  // each must be shown, not silently overwritten by the last one.
  const [consentQueue, setConsentQueue] = useState<Array<{ plugin: PluginRow; version: string; newPermissions: string[]; newEgress: string[] }>>([])
  // Open when enabling a plugin is blocked by missing/outdated plugin dependencies.
  const [depResolve, setDepResolve] = useState<{ plugin: PluginRow; missing: PluginDep[]; versionMismatch: VersionMismatch[] } | null>(null)
  const [menu, setMenu] = useState<string | null>(null)

  // Toolbar state.
  const [q, setQ] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<SortKey>('name')

  // 'updates' only ranks installed plugins, 'downloads' only the registry — snap
  // the key back to name when switching tabs so the dropdown never carries a label
  // for an option the active tab can't offer.
  useEffect(() => {
    if (view === 'discover' && sort === 'updates') setSort('name')
    else if (view === 'installed' && sort === 'downloads') setSort('name')
  }, [view, sort])

  // Sideload upload: drag a plugin .zip onto the panel or use the toolbar button.
  const [dragActive, setDragActive] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  // Index the registry once per fetch: the version map the update badges read, plus the
  // whole entry (author key + signed flag) the trust badges and re-trust dialog need.
  // The map holds latestCompatible — the newest version THIS TREK can install (computed
  // server-side) — not the absolute latest, so the banner never counts an update the
  // update endpoint would refuse.
  const indexRegistry = (items: RegistryItem[]) => {
    const vers: Record<string, string> = {}
    const byId: Record<string, RegistryItem> = {}
    items.forEach((i) => { byId[i.id] = i; if (i.latestCompatible) vers[i.id] = i.latestCompatible })
    setLatest(vers)
    setRegById(byId)
  }

  const refresh = () => {
    // Keep the app-wide active-plugin store in sync so widget/hero/tab consumers
    // (e.g. the dashboard) reflect an activate/deactivate without a full reload (F5).
    void usePluginStore.getState().loadPlugins()
    adminApi.plugins()
      .then((d: { enabled: boolean; devLink?: boolean; ignoreTrekRange?: boolean; plugins: PluginRow[] }) => {
        setRuntimeOn(!!d.enabled)
        setDevLink(!!d.devLink)
        setIgnoreTrekRange(!!d.ignoreTrekRange)
        setPlugins(d.plugins || [])
        if ((d.plugins || []).length) {
          adminApi.pluginBrowse().then(indexRegistry).catch(() => {})
        }
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }
  useEffect(refresh, [])

  // A signature refusal is not an ordinary "action failed": it is the one class of error
  // where WHICH failure it was decides what the admin may do about it. Route it to the
  // dialog off the CODE, never off the message text. Returns true when handled.
  //
  // The subject is resolved from wherever it can be — the installed row, else the registry
  // entry (a plugin being INSTALLED has no row yet), else the bare id. A signature code
  // ALWAYS opens the dialog: falling back to a toast is what used to hide an invalid
  // signature on a fresh install behind the same treatment as a network blip.
  const routeSignatureError = (id: string, code?: string, detail?: string): boolean => {
    if (!code || !SIGNATURE_CODES.includes(code)) return false
    const row = plugins.find(p => p.id === id)
    const subject: SigSubject = row
      ? { id, name: row.name, keyFingerprint: row.keyFingerprint ?? null }
      // Not installed: no pinned key exists, so SIGNATURE_KEY_CHANGED cannot arise and the
      // dialog shows the no-override explanation — which is exactly right.
      : { id, name: regById[id]?.name ?? id, keyFingerprint: null }
    setSignatureBlock({ subject, code, detail: detail ?? null })
    return true
  }

  const act = async (id: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id); setMenu(null)
    try { await fn(); toast.success(ok) }
    catch (e) {
      const { error, code } = errBody(e)
      if (!routeSignatureError(id, code, error)) toast.error(error || t('admin.plugins.actionError'))
    }
    finally { setBusy(null); refresh() }
  }

  const openDiscover = () => {
    setView('discover')
    if (!registry) {
      adminApi.pluginBrowse()
        .then((items: RegistryItem[]) => { setRegistry(items); indexRegistry(items) })
        .catch(() => setRegistry([]))
    }
  }
  // The rescan/reload button rediscovers locally-installed plugins AND force-pulls
  // the remote registry (bypassing the 30-min server cache + GitHub's CDN), so a
  // just-published plugin shows up right away instead of up to ~35 min later.
  const rescan = () => act('__rescan', async () => {
    await adminApi.pluginRescan()
    const items: RegistryItem[] = await adminApi.pluginBrowse(true)
    setRegistry(items)
    indexRegistry(items)
  }, t('admin.plugins.rescanned'))

  // Sideload a plugin archive (installs INACTIVE — the admin still consents on activation).
  const uploadPlugin = async (file: File) => {
    setBusy('__upload'); setMenu(null)
    try {
      const res = await adminApi.pluginUpload(file)
      setView('installed')
      toast.success(t('admin.plugins.uploaded', { name: res.id }))
      bypass.notice(res.id, res.trekRangeBypassed)
    } catch (e) {
      toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || t('admin.plugins.actionError'))
    } finally {
      setBusy(null); refresh()
    }
  }
  const pickUpload = () => uploadInputRef.current?.click()
  const onDragEnter = (e: DragEvent) => {
    if (!runtimeOn || !Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault(); dragDepth.current++; setDragActive(true)
  }
  const onDragLeave = () => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragActive(false) } }
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); dragDepth.current = 0; setDragActive(false)
    if (!runtimeOn) return
    const f = e.dataTransfer.files?.[0]
    if (f) void uploadPlugin(f)
  }
  const openEgress = (id: string) => {
    setMenu(null)
    setEgressDraft(''); setEgressError('')
    adminApi.pluginEgressHosts(id)
      .then(d => setEgressFor({ id, supported: d.supported, hosts: d.hosts }))
      .catch(() => setEgressFor({ id, supported: false, hosts: [] }))
  }

  // Saving RE-SPAWNS the plugin: the child's egress guard is installed once at init and
  // a second init is refused, so a live child's allow-list can never be widened in place.
  const saveEgress = async (hosts: string[]) => {
    if (!egressFor) return
    setEgressSaving(true); setEgressError('')
    try {
      const d = await adminApi.pluginSetEgressHosts(egressFor.id, hosts)
      setEgressFor({ ...egressFor, hosts: d.hosts })
      setEgressDraft('')
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      setEgressError(err.response?.data?.error || t('common.error'))
    } finally {
      setEgressSaving(false)
    }
  }

  const openInstanceSettings = (p: { id: string; status: string }) => {
    setMenu(null)
    settings.open(p.id, p.status === 'active')
  }

  const openErrors = (id: string) => {
    setMenu(null)
    adminApi.pluginErrors(id)
      .then((d: { errors: Array<{ ts: string; level: string; message: string }> }) => setErrorsFor({ id, rows: d.errors }))
      .catch(() => setErrorsFor({ id, rows: [] }))
  }

  // A held plugin (deliberate non-latest install) is deliberately NOT an update candidate:
  // the admin just rolled it back, and the banner nagging them straight back would make
  // the rollback fight the UI. The row carries its own "paused" marker + resume instead.
  const updateAvailable = (p: PluginRow) => !!(p.version && !p.updateHold && latest[p.id] && isNewer(latest[p.id], p.version))
  const resumeUpdates = (p: PluginRow) => act(p.id, () => adminApi.pluginResumeUpdates(p.id), t('admin.plugins.updatesResumed'))
  // A newer version exists but this TREK can't install it (and it isn't the one on offer):
  // said passively on the row, so the admin learns a TREK upgrade unlocks it instead of
  // wondering why no update shows. Null when the registry gives no range to point at.
  const newerIncompatible = (p: PluginRow): { version: string; range: string } | null => {
    const reg = regById[p.id]
    if (!reg?.latest || !p.version || !isNewer(reg.latest, p.version)) return null
    if (latest[p.id] === reg.latest) return null
    const range = reg.trek ?? (reg.minTrekVersion ? `>=${reg.minTrekVersion}` : null)
    return range ? { version: reg.latest, range } : null
  }
  // `warn` is the pre-install confirm for an entry the registry already flagged as
  // incompatible; an artifact whose OWN manifest turns out to be out of range (the index
  // was only a pre-download filter) is caught by the marker on the response instead.
  const install = (id: string, version?: string, warn?: RangeWarning) => bypass.guard(warn, () =>
    act(id, () => adminApi.pluginInstall(id, version ? { version } : undefined).then(r => { if (!warn) bypass.notice(id, r?.trekRangeBypassed) }), t('admin.plugins.installed')))
  const restart = (id: string) => act(id, async () => { await adminApi.pluginDeactivate(id); await adminApi.pluginActivate(id) }, t('admin.plugins.restarted'))
  // Dev-link: register a plugin from a local built directory (dev only). Reuses the
  // same busy/toast/refresh loop as uploadPlugin; the server gates it.
  const linkLocal = async () => {
    const p = linkPath.trim()
    if (!p) return
    setBusy('__link'); setMenu(null)
    try {
      const res = await adminApi.pluginLink(p)
      setView('installed')
      setLinkPath('')
      toast.success(t('admin.plugins.devLinkLinked', { id: res.id }))
      bypass.notice(res.id, res.trekRangeBypassed)
    } catch (e) {
      toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || t('admin.plugins.actionError'))
    } finally {
      setBusy(null); refresh()
    }
  }
  const installedIds = new Set(plugins.map(p => p.id))

  // Installed-but-disabled direct deps that enabling `p` will auto-enable first.
  const autoEnabledDeps = (p: PluginRow) =>
    (p.dependencies?.pluginDependencies ?? [])
      .map(d => plugins.find(x => x.id === d.id))
      .filter((x): x is PluginRow => !!x && x.enabled === 0)
      .map(x => x.name)

  // Shared handling for a failed activation: route each 409 code to the right fix
  // (consent dialog, download-dependency dialog, or a clear toast).
  const onActivateError = (p: PluginRow, e: ActivateErr) => {
    const d = e?.response?.data
    if (e?.response?.status === 409 && d?.code === 'CONSENT_REQUIRED') {
      setConsentQueue(qq => [...qq, { plugin: p, version: latest[p.id] ?? p.version ?? '', newPermissions: d.newPermissions ?? [], newEgress: d.newEgress ?? [] }])
    } else if (e?.response?.status === 409 && d?.code === 'ADDON_DISABLED') {
      toast.error(t('admin.plugins.dep.addonDisabledToast', { addons: (d.addons ?? []).join(', ') }))
    } else if (e?.response?.status === 409 && d?.code === 'DEPENDENCY_MISSING') {
      setDepResolve({ plugin: p, missing: d.missing ?? [], versionMismatch: d.versionMismatch ?? [] })
    } else {
      // DEPENDENCY_CYCLE and everything else surface their server message.
      toast.error(d?.error || t('admin.plugins.actionError'))
    }
  }

  const attemptActivate = (p: PluginRow) => {
    const cascaded = autoEnabledDeps(p)
    return adminApi.pluginActivate(p.id)
      .then(() => {
        toast.success(t('admin.plugins.activated'))
        if (cascaded.length) toast.success(t('admin.plugins.dep.autoEnabled', { plugins: cascaded.join(', ') }))
        setDepResolve(null)
      })
      .catch((e: ActivateErr) => onActivateError(p, e))
  }

  // Enable/disable a plugin. Re-enabling one whose update widened its permissions
  // must NOT grant them silently (409 CONSENT_REQUIRED → consent dialog); a disabled
  // required addon or a missing plugin dependency (409 ADDON_DISABLED /
  // DEPENDENCY_MISSING) routes to the right remedy.
  const toggle = (p: PluginRow) => {
    if (busy === p.id) return
    if (p.enabled === 1) { void act(p.id, () => adminApi.pluginDeactivate(p.id), t('admin.plugins.deactivated')); return }
    setBusy(p.id); setMenu(null)
    attemptActivate(p).finally(() => { setBusy(null); refresh() })
  }

  // Download a missing/outdated plugin dependency (latest compatible for its range,
  // transitively), then retry enabling the plugin that needed it.
  const resolveDependency = (parent: PluginRow, depId: string, constraint?: string) => {
    if (busy === parent.id) return
    setBusy(parent.id)
    adminApi.pluginInstall(depId, { constraint, withDependencies: true })
      .then((r: { installed?: string[]; requiredAddons?: string[]; trekRangeBypassed?: TrekRangeBypass | null }) => {
        toast.success(t('admin.plugins.dep.downloaded', { id: depId }))
        if (r?.requiredAddons?.length) toast.error(t('admin.plugins.dep.addonDisabledToast', { addons: r.requiredAddons.join(', ') }))
        bypass.notice(depId, r?.trekRangeBypassed)
        return attemptActivate(parent)
      })
      // The DEPENDENCY is what's being downloaded, so a signature refusal here is about the
      // dependency's author, not the parent's — route it under depId before falling through
      // to the activation-error handling, which knows nothing about signature codes.
      .catch((e: ActivateErr) => {
        const { error, code } = errBody(e)
        if (!routeSignatureError(depId, code, error)) onActivateError(parent, e)
      })
      .finally(() => { setBusy(null); refresh() })
  }

  // `version` pins the exact version to install (rollback / explicit switch); omitted,
  // the server resolves the newest TREK-compatible version itself.
  const runUpdate = (p: PluginRow, version?: string) => {
    setBusy(p.id); setMenu(null)
    return adminApi.pluginUpdate(p.id, version)
      .then((r: { version: string; activated: boolean; newPermissions: string[]; newEgress: string[]; trekRangeBypassed?: TrekRangeBypass | null }) => {
        if (r.activated || (r.newPermissions.length === 0 && r.newEgress.length === 0)) toast.success(t('admin.plugins.updated'))
        else setConsentQueue(qq => [...qq, { plugin: p, version: r.version, newPermissions: r.newPermissions, newEgress: r.newEgress }])
        bypass.notice(p.name, r.trekRangeBypassed)
      })
      .catch(e => {
        const { error, code } = errBody(e)
        if (!routeSignatureError(p.id, code, error)) toast.error(error || t('admin.plugins.actionError'))
      })
      .finally(() => { setBusy(null); refresh() })
  }

  // Confirm a key rotation: re-pin the new key AND update, in one server call. There is no
  // follow-up /update — a re-pin that waited for a second call would leave the plugin
  // pinned to a key no install had ever been verified against if that call never came.
  const confirmRetrust = (id: string, version: string, publicKey: string) => {
    setRetrusting(true)
    adminApi.pluginRetrust(id, version, publicKey)
      .then((r: { version: string; activated: boolean; newPermissions: string[]; newEgress: string[] }) => {
        setSignatureBlock(null)
        // A re-trusted update widening permissions still needs consent — re-trusting a
        // signing key says nothing about what the new code is allowed to do. Re-trust only
        // ever fires for an INSTALLED plugin, so the row is there to consent against.
        const p = plugins.find(x => x.id === id)
        if (p && !r.activated && (r.newPermissions.length > 0 || r.newEgress.length > 0)) {
          setConsentQueue(qq => [...qq, { plugin: p, version: r.version, newPermissions: r.newPermissions, newEgress: r.newEgress }])
        } else toast.success(t('admin.plugins.retrusted'))
      })
      .catch(e => toast.error(errBody(e).error || t('admin.plugins.actionError')))
      .finally(() => { setRetrusting(false); refresh() })
  }

  // "Change version…" on an installed row: fetch the per-version list (with the server's
  // compat verdicts) and open the picker. The fetch is keyed to the plugin so a stale
  // response can't populate a picker that was reopened for another row.
  const openVersionPicker = (p: PluginRow) => {
    setMenu(null)
    setVersionPicker({ plugin: p, versions: null, failed: false })
    adminApi.pluginDetail(p.id)
      .then((d: RegistryDetail) => setVersionPicker(cur => (cur && cur.plugin.id === p.id ? { ...cur, versions: d.versions ?? [] } : cur)))
      .catch(() => setVersionPicker(cur => (cur && cur.plugin.id === p.id ? { ...cur, failed: true } : cur)))
  }

  // Switching DOWN keeps the plugin's data dir, which the older code may not understand —
  // that asks for explicit consent first. Any other switch is the ordinary update path.
  const pickVersion = (version: string) => {
    if (!versionPicker) return
    const p = versionPicker.plugin
    setVersionPicker(null)
    if (p.version && isNewer(p.version, version)) setConfirmDowngrade({ plugin: p, version })
    else void runUpdate(p, version)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const updatable = useMemo(() => plugins.filter(updateAvailable), [plugins, latest])

  // One after another: busy is a single slot, so parallel updates would leave the
  // other rows clickable mid-install and refresh once per plugin.
  const updateAll = async () => {
    for (const p of updatable) await runUpdate(p)
  }

  // Installed list after search / type / status filters + sort.
  const shownInstalled = useMemo(() => {
    const term = q.trim().toLowerCase()
    let rows = plugins.filter(p => {
      const matchesText = !term || `${p.name} ${p.description ?? ''}`.toLowerCase().includes(term)
      const matchesType = typeFilter === 'all' || p.type === typeFilter
      const st = statusFilter === 'all' ? true
        : statusFilter === 'on' ? p.enabled === 1 && p.status !== 'error'
        : statusFilter === 'off' ? p.enabled === 0
        : statusFilter === 'update' ? updateAvailable(p)
        : p.status === 'error'
      return matchesText && matchesType && st
    })
    rows = [...rows].sort((a, b) => {
      if (sort === 'updates') {
        const ua = updateAvailable(a) ? 0 : 1, ub = updateAvailable(b) ? 0 : 1
        if (ua !== ub) return ua - ub
      }
      return a.name.localeCompare(b.name)
    })
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins, q, typeFilter, statusFilter, sort, latest])

  // Registry list after search / type filter.
  const shownRegistry = useMemo(() => {
    if (!registry) return null
    const term = q.trim().toLowerCase()
    let items = registry.filter(r => {
      const matchesText = !term || `${r.name} ${r.author} ${r.description}`.toLowerCase().includes(term)
      const matchesType = typeFilter === 'all' || r.type === typeFilter
      return matchesText && matchesType
    })
    items = [...items].sort((a, b) => {
      if (sort === 'downloads') return (b.downloadCount ?? 0) - (a.downloadCount ?? 0) || a.name.localeCompare(b.name)
      if (sort === 'recent') return (Date.parse(b.reviewedAt ?? '') || 0) - (Date.parse(a.reviewedAt ?? '') || 0) || a.name.localeCompare(b.name)
      return a.name.localeCompare(b.name)
    })
    return items
  }, [registry, q, typeFilter, sort])

  const anyFilter = q.trim() !== '' || typeFilter !== 'all' || statusFilter !== 'all'

  return (
    <div className="relative bg-surface-card border border-edge rounded-2xl shadow-card mb-24 sm:mb-0"
      onDragEnter={onDragEnter} onDragOver={e => { if (dragActive) e.preventDefault() }} onDragLeave={onDragLeave} onDrop={onDrop}>
      {/* Hidden input for the toolbar "Upload plugin" button (drag-drop uses the same handler). */}
      <input ref={uploadInputRef} type="file" accept=".zip,.tgz,.tar.gz" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) void uploadPlugin(f); e.target.value = '' }} />
      {/* Drag-to-install overlay */}
      {dragActive && (
        <div className="absolute inset-0 z-40 rounded-2xl border-2 border-dashed border-accent bg-accent-soft/70 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2.5 pointer-events-none">
          <UploadCloud size={34} className="text-accent" />
          <span className="text-sm font-semibold text-accent">{t('admin.plugins.dropToUpload')}</span>
        </div>
      )}
      {/* Click-away layer for any open dropdown (filters or a row's ⋯ menu). */}
      {menu && <div role="presentation" className="fixed inset-0 z-20" onClick={() => setMenu(null)} />}
      {/* Header */}
      <div className="px-4 sm:px-6 pt-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-content">{t('admin.plugins.title')}</h2>
            <p className="text-xs mt-1 text-content-muted max-w-xl">{t('admin.plugins.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {runtimeOn && ignoreTrekRange && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-warning bg-warning-soft px-2.5 py-1.5 rounded-full"
                title={t('admin.plugins.rangeBypass.pillHint')}>
                <AlertTriangle size={12} /> {t('admin.plugins.rangeBypass.pill')}
              </span>
            )}
            {runtimeOn && (
              <span className="inline-flex items-center gap-2 text-[11px] font-semibold text-success bg-success-soft px-2.5 py-1.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-success" /> {t('admin.plugins.runtimeOn')}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Runtime-disabled notice */}
      {!runtimeOn && !loading && !error && (
        <div className="mx-4 sm:mx-6 mt-4 p-4 rounded-xl border border-warning/30 bg-warning-soft flex items-start gap-3">
          <AlertTriangle size={16} className="text-warning mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-content">{t('admin.plugins.disabledTitle')}</p>
            <p className="text-xs text-content-muted mt-0.5">{t('admin.plugins.disabledBody')}</p>
          </div>
        </div>
      )}

      {/* Dev-link: register + hot-reload a plugin from a local build dir (dev only). */}
      {devLink && runtimeOn && !loading && !error && (
        <form onSubmit={(e) => { e.preventDefault(); void linkLocal() }}
          className="mx-4 sm:mx-6 mt-4 p-3 rounded-xl border border-accent/30 bg-accent-soft flex flex-col sm:flex-row sm:items-center gap-2.5">
          <div className="flex items-center gap-2 shrink-0 text-accent" title={t('admin.plugins.devLinkHint')}>
            <Link2 size={15} />
            <span className="text-xs font-semibold">{t('admin.plugins.devLinkTitle')}</span>
          </div>
          <input value={linkPath} onChange={(e) => setLinkPath(e.target.value)} spellCheck={false}
            placeholder={t('admin.plugins.devLinkPathPlaceholder')}
            className="flex-1 min-w-0 h-[34px] px-2.5 rounded-lg border border-edge bg-surface-card text-sm text-content placeholder:text-content-faint focus:outline-none focus:border-accent" />
          <button type="submit" disabled={!linkPath.trim() || busy === '__link'}
            className="h-[34px] px-3.5 shrink-0 inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors">
            <Link2 size={14} /> {t('admin.plugins.devLinkButton')}
          </button>
        </form>
      )}

      {/* Toolbar — on mobile: tabs+rescan, then full-width search, then a
          right-aligned filter row. On sm+ the wrappers collapse (sm:contents)
          so everything sits in one wrapping row. */}
      {runtimeOn && !loading && !error && (
        <div className="relative z-30 px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2.5">
          <div className="flex items-center justify-between gap-2.5 sm:contents">
            <div className="inline-flex bg-surface-tertiary border border-edge-secondary rounded-xl p-0.5 gap-0.5">
              <SegBtn active={view === 'installed'} onClick={() => setView('installed')} label={t('admin.plugins.installed')} count={plugins.length} />
              <SegBtn active={view === 'discover'} onClick={openDiscover} label={t('admin.plugins.tabDiscover')} count={registry?.length} />
            </div>
            <div className="sm:hidden flex items-center gap-2 shrink-0">
              <button type="button" onClick={pickUpload} title={t('admin.plugins.upload')}
                className="h-[38px] w-[38px] grid place-items-center rounded-xl border border-edge bg-surface-card text-content-muted hover:text-content hover:border-content-faint transition-colors">
                <UploadCloud size={15} />
              </button>
              <button type="button" onClick={rescan} title={t('admin.plugins.rescan')}
                className="h-[38px] w-[38px] grid place-items-center rounded-xl border border-edge bg-surface-card text-content-muted hover:text-content hover:border-content-faint transition-colors">
                <RefreshCw size={15} />
              </button>
            </div>
          </div>

          <div className="relative w-full sm:flex-1 sm:min-w-[160px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-content-faint pointer-events-none" />
            <input
              value={q} onChange={e => setQ(e.target.value)} type="search"
              placeholder={t('admin.plugins.searchPlaceholder')}
              className="w-full h-[38px] pl-9 pr-3 rounded-xl border border-edge bg-surface-secondary text-sm text-content placeholder:text-content-faint outline-none focus:bg-surface-card focus:border-content-faint transition-colors"
            />
          </div>

          <div className="flex items-center justify-end gap-2 sm:gap-2.5 sm:contents">
            <FilterMenu id="type" label={t('admin.plugins.filterType')} value={typeFilter} menu={menu} setMenu={setMenu} icon={<SlidersHorizontal size={14} />}
              options={[
                ['all', t('admin.plugins.allTypes')], ['widget', t('admin.plugins.type.widget')],
                ['integration', t('admin.plugins.type.integration')], ['page', t('admin.plugins.type.page')],
                ['trip-page', t('admin.plugins.type.trip-page')],
              ]}
              valueLabel={typeFilter === 'all' ? t('admin.plugins.allTypes') : t(`admin.plugins.type.${typeFilter}` as never)}
              onPick={v => setTypeFilter(v as TypeFilter)} />

            {view === 'installed' && (
              <FilterMenu id="status" label={t('admin.plugins.filterStatus')} value={statusFilter} menu={menu} setMenu={setMenu} icon={<CircleDot size={14} />}
                options={[
                  ['all', t('admin.plugins.allStatuses')], ['on', t('admin.plugins.status.active')], ['off', t('admin.plugins.stateOff')],
                  ['update', t('admin.plugins.filterUpdate')], ['err', t('admin.plugins.status.error')],
                ]}
                valueLabel={statusLabel(statusFilter, t)}
                onPick={v => setStatusFilter(v as StatusFilter)} />
            )}

            <FilterMenu id="sort" label={t('admin.plugins.sortBy')} value={sort} menu={menu} setMenu={setMenu} icon={<ArrowUpDown size={14} />}
              options={view === 'discover'
                ? [['name', t('admin.plugins.sortName')], ['recent', t('admin.plugins.sortRecent')], ['downloads', t('admin.plugins.sortDownloads')]]
                : [['name', t('admin.plugins.sortName')], ['recent', t('admin.plugins.sortRecent')], ['updates', t('admin.plugins.sortUpdates')]]}
              valueLabel={sortLabel(sort, t)}
              onPick={v => setSort(v as SortKey)} />

            <button type="button" onClick={pickUpload} title={t('admin.plugins.upload')}
              className="hidden sm:grid h-[38px] w-[38px] place-items-center rounded-xl border border-edge bg-surface-card text-content-muted hover:text-content hover:border-content-faint transition-colors">
              <UploadCloud size={15} />
            </button>
            <button type="button" onClick={rescan} title={t('admin.plugins.rescan')}
              className="hidden sm:grid h-[38px] w-[38px] place-items-center rounded-xl border border-edge bg-surface-card text-content-muted hover:text-content hover:border-content-faint transition-colors">
              <RefreshCw size={15} />
            </button>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="pb-1">
        {loading ? (
          <div className="py-14 text-center text-sm text-content-faint">{t('common.loading')}</div>
        ) : error ? (
          <div className="py-14 text-center text-sm text-danger">{t('admin.plugins.loadError')}</div>
        ) : !runtimeOn ? null : view === 'discover' ? (
          <RegistryGrid items={shownRegistry} busy={busy} t={t} installedIds={installedIds} ignoreTrekRange={ignoreTrekRange}
            onInstall={install} onOpenDetail={setDetailFor} filtered={anyFilter} />
        ) : plugins.length === 0 ? (
          <EmptyState t={t} onDiscover={openDiscover} />
        ) : (
          <div className="px-2 sm:px-3">
            {updatable.length > 0 && statusFilter !== 'err' && (
              <div className="mx-1.5 sm:mx-3 mb-2 mt-1 flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-warning-soft border border-warning/30">
                <ArrowUpCircle size={16} className="text-warning shrink-0" />
                <span className="text-xs text-content-secondary">{t('admin.plugins.updatesAvailable', { count: updatable.length })}</span>
                <button type="button" onClick={() => void updateAll()}
                  className="ml-auto text-xs font-semibold px-3 py-1.5 rounded-lg bg-warning text-white hover:opacity-90 transition-opacity">
                  {t('admin.plugins.updateAll')}
                </button>
              </div>
            )}
            {shownInstalled.length === 0 ? (
              <div className="py-12 text-center">
                <Search size={26} className="text-content-faint/60 mx-auto mb-3" />
                <p className="text-sm text-content-faint">{t('admin.plugins.noMatchInstalled')}</p>
              </div>
            ) : shownInstalled.map(p => (
              <InstalledRow key={p.id} p={p} t={t} busy={busy} menu={menu} setMenu={setMenu}
                hasUpdate={updateAvailable(p)} latestVer={latest[p.id]}
                newerIncompatible={newerIncompatible(p)}
                blocked={blockIsCurrent(p, latest[p.id])}
                onToggle={() => toggle(p)}
                onUpdate={() => runUpdate(p)} onRestart={() => restart(p.id)}
                onChangeVersion={() => openVersionPicker(p)}
                onResume={() => void resumeUpdates(p)}
                onReviewBlock={() => setSignatureBlock({
                  subject: { id: p.id, name: p.name, keyFingerprint: p.keyFingerprint ?? null },
                  code: p.updateBlock!.code, detail: p.updateBlock!.detail,
                })}
                onErrors={() => openErrors(p.id)} onEgress={() => openEgress(p.id)}
                onSettings={() => openInstanceSettings(p)}
                onUninstall={() => { setMenu(null); setConfirmUninstall(p) }} />
            ))}
          </div>
        )}
      </div>

      <SecurityInfo t={t} />

      {/* Registry detail dialog */}
      {detailFor && (
        <PluginDetailModal item={detailFor} t={t} locale={locale} busy={busy} ignoreTrekRange={ignoreTrekRange}
          installed={installedIds.has(detailFor.id)} onInstall={install} onClose={() => setDetailFor(null)} />
      )}

      {bypass.copy && <RangeBypassDialog copy={bypass.copy} t={t} onConfirm={bypass.confirm} onClose={bypass.dismiss} />}

      {/* Error-log modal */}
      {errorsFor && (
        <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setErrorsFor(null)}>
          <div role="presentation" className="bg-surface-card border border-edge rounded-2xl w-full max-w-2xl max-h-[70vh] flex flex-col shadow-modal" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3.5 border-b border-edge-secondary flex items-center justify-between">
              <span className="text-sm font-semibold text-content flex items-center gap-2"><Bug size={15} /> {errorsFor.id} — {t('admin.plugins.errorLog')}</span>
              <button type="button" onClick={() => setErrorsFor(null)} className="text-content-faint hover:text-content"><X size={16} /></button>
            </div>
            <div className="p-4 overflow-y-auto text-xs font-mono">
              {errorsFor.rows.length === 0 ? <p className="text-content-faint py-4 text-center">{t('admin.plugins.noErrors')}</p> :
                errorsFor.rows.map((r, i) => (
                  <div key={i} className="py-1.5 border-b border-edge-secondary/50 last:border-0 flex gap-2">
                    <span className={`shrink-0 font-semibold ${r.level === 'error' ? 'text-danger' : 'text-warning'}`}>{r.level}</span>
                    <span className="text-content-faint shrink-0">{r.ts}</span>
                    <span className="text-content-muted break-all">{r.message}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* Operator-supplied egress hosts */}
      {egressFor && (
        <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setEgressFor(null)}>
          <div role="presentation" className="bg-surface-card border border-edge rounded-2xl w-full max-w-lg max-h-[88vh] flex flex-col shadow-modal" onClick={e => e.stopPropagation()}>
            <div className="shrink-0 px-5 py-3.5 border-b border-edge-secondary flex items-center justify-between">
              <span className="text-sm font-semibold text-content flex items-center gap-2"><Globe size={15} /> {egressFor.id} — {t('admin.plugins.allowedHosts')}</span>
              <button type="button" onClick={() => setEgressFor(null)} className="text-content-faint hover:text-content"><X size={16} /></button>
            </div>
            <div className="p-5 space-y-3 min-h-0 flex-1 overflow-y-auto">
              {!egressFor.supported ? (
                <p className="text-sm text-content-faint">{t('admin.plugins.allowedHosts.unsupported')}</p>
              ) : (
                <>
                  <p className="text-xs text-content-faint">{t('admin.plugins.allowedHosts.hint')}</p>
                  {egressFor.hosts.length === 0 && (
                    <p className="text-sm text-content-faint italic">{t('admin.plugins.allowedHosts.none')}</p>
                  )}
                  {egressFor.hosts.map(h => (
                    <div key={h} className="flex items-center justify-between gap-2 rounded-lg border border-edge-secondary px-3 py-2">
                      <span className="text-sm font-mono text-content break-all">{h}</span>
                      <button type="button"
                        disabled={egressSaving}
                        onClick={() => saveEgress(egressFor.hosts.filter(x => x !== h))}
                        className="text-content-faint hover:text-danger disabled:opacity-50"
                        aria-label={t('common.delete')}
                      ><Trash2 size={14} /></button>
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <input
                      value={egressDraft}
                      onChange={e => setEgressDraft(e.target.value)}
                      placeholder="gotify.example.com"
                      className="flex-1 rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content"
                    />
                    <button type="button"
                      disabled={egressSaving || !egressDraft.trim()}
                      onClick={() => saveEgress([...egressFor.hosts, egressDraft.trim()])}
                      className="rounded-lg bg-content px-3 py-2 text-sm text-surface disabled:opacity-50"
                    >{t('common.add')}</button>
                  </div>
                  {egressError && <p className="text-xs text-danger">{egressError}</p>}
                  <p className="text-xs text-content-faint">{t('admin.plugins.allowedHosts.restartNote')}</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Instance-wide settings (the admin-owned scope:'instance' fields) */}
      {settings.form && (
        <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={settings.close}>
          <div role="presentation" className="bg-surface-card border border-edge rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-modal" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3.5 border-b border-edge-secondary flex items-center justify-between">
              <span className="text-sm font-semibold text-content flex items-center gap-2"><SlidersHorizontal size={15} /> {settings.form.id} — {t('admin.plugins.instanceSettings')}</span>
              <button type="button" aria-label={t('common.close')} onClick={settings.close} className="text-content-faint hover:text-content"><X size={16} /></button>
            </div>
            <div className="p-5 space-y-4 overflow-y-auto">
              {settings.form.fields.map(f => (
                <label key={f.key} className="block">
                  <span className="block text-sm font-medium text-content-secondary mb-1">
                    {f.label || f.key}{f.required && <span className="text-danger"> *</span>}
                  </span>
                  {f.input_type === 'checkbox' ? (
                    <input
                      type="checkbox"
                      checked={settings.form.values[f.key] === true}
                      onChange={e => settings.setValue(f.key, e.target.checked)}
                      className="h-4 w-4 rounded border-edge"
                    />
                  ) : f.input_type === 'select' && f.options ? (
                    <select
                      value={String(settings.form.values[f.key] ?? '')}
                      onChange={e => settings.setValue(f.key, e.target.value)}
                      className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content"
                    >
                      <option value="">—</option>
                      {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <input
                      type={f.secret ? 'password' : (f.input_type === 'number' ? 'number' : 'text')}
                      value={String(settings.form.values[f.key] ?? '')}
                      placeholder={f.placeholder || ''}
                      autoComplete={f.secret ? 'new-password' : 'off'}
                      onChange={e => settings.setValue(f.key, e.target.value)}
                      className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content"
                    />
                  )}
                  {f.hint && <span className="block text-xs text-content-muted mt-1">{f.hint}</span>}
                </label>
              ))}
              {(() => {
                const form = settings.form
                if (!form || form.actions.length === 0) return null
                return (
                  <div className="border-t border-edge-secondary pt-4">
                    <span className="block text-xs font-semibold uppercase tracking-wide text-content-muted mb-2">
                      {t('admin.plugins.actions')}
                    </span>
                    {!form.active && (
                      <p className="text-xs text-content-muted mb-2">{t('admin.plugins.actions.inactive')}</p>
                    )}
                    <div className="flex flex-col gap-2">
                      {form.actions.map(a => {
                        const res = settings.actionResult[a.key]
                        return (
                          <div key={a.key} className="flex flex-wrap items-center gap-2">
                            <button type="button"
                              onClick={() => settings.runAction(a)}
                              disabled={!form.active || settings.runningAction !== null || settings.saving}
                              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:opacity-60 ${
                                a.danger ? 'border-danger text-danger' : 'border-edge text-content'
                              }`}
                            >
                              {settings.runningAction === a.key && <Loader2 className="w-4 h-4 animate-spin" />}
                              {a.label}
                            </button>
                            {a.hint && <span className="text-xs text-content-muted">{a.hint}</span>}
                            {res && (
                              <span aria-live="polite" className={`text-xs font-medium ${res.ok ? 'text-success' : 'text-danger'}`}>
                                {res.message || (res.ok ? t('common.success') : t('common.error'))}
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}
              {settings.error && <p className="text-xs text-danger">{settings.error}</p>}
            </div>
            <div className="px-5 py-3.5 border-t border-edge-secondary flex justify-end">
              <button type="button"
                disabled={settings.saving || settings.runningAction !== null}
                onClick={() => void settings.save()}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-text disabled:opacity-60"
              >{t('common.save')}</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={settings.pendingAction !== null}
        onClose={settings.cancelPendingAction}
        onConfirm={settings.confirmPendingAction}
        title={settings.pendingAction?.label ?? ''}
        message={t('admin.plugins.actions.confirm')}
        confirmLabel={t('common.confirm')}
      />

      <ConfirmDialog
        isOpen={!!confirmUninstall}
        onClose={() => setConfirmUninstall(null)}
        onConfirm={async () => {
          const p = confirmUninstall!; setConfirmUninstall(null)
          await act(p.id, () => adminApi.pluginUninstall(p.id, true), t('admin.plugins.uninstalled'))
        }}
        title={t('admin.plugins.uninstallTitle')}
        message={t('admin.plugins.uninstallBody')}
      />

      {versionPicker && (
        <VersionPickerDialog plugin={versionPicker.plugin} versions={versionPicker.versions} failed={versionPicker.failed}
          busy={busy} t={t} locale={locale} onPick={pickVersion} onClose={() => setVersionPicker(null)} />
      )}

      <ConfirmDialog
        isOpen={!!confirmDowngrade}
        onClose={() => setConfirmDowngrade(null)}
        onConfirm={() => { const d = confirmDowngrade!; setConfirmDowngrade(null); void runUpdate(d.plugin, d.version) }}
        title={t('admin.plugins.downgradeTitle')}
        message={t('admin.plugins.downgradeBody', { from: confirmDowngrade?.plugin.version ?? '', to: confirmDowngrade?.version ?? '' })}
        confirmLabel={t('admin.plugins.downgradeConfirm')}
      />

      {signatureBlock && (
        <SignatureBlockDialog
          data={signatureBlock} entry={regById[signatureBlock.subject.id]} busy={retrusting} t={t}
          onRetrust={(version, publicKey) => confirmRetrust(signatureBlock.subject.id, version, publicKey)}
          onClose={() => setSignatureBlock(null)}
        />
      )}

      {consentQueue[0] && (
        <UpdateConsentDialog
          data={consentQueue[0]} t={t}
          // Prefer the REGISTRY's flag — consent is about the code being installed, not the
          // code running now — but fall back to the installed row's, which the server always
          // sends. Reading only the registry meant an unreachable registry left `regById`
          // empty and the warning silently vanished at the exact moment an admin was widening
          // what unsigned code may do.
          unsigned={
            isRegistrySourced(consentQueue[0].plugin.source_repo) &&
            (regById[consentQueue[0].plugin.id]?.signed ?? consentQueue[0].plugin.signed) === false
          }
          onApprove={async () => {
            const c = consentQueue[0]; setConsentQueue(qq => qq.slice(1))
            // consent:true — the ONLY path that may widen a plugin's granted rights.
            await act(c.plugin.id, () => adminApi.pluginActivate(c.plugin.id, true), t('admin.plugins.updated'))
          }}
          onLater={() => { setConsentQueue(qq => qq.slice(1)); toast.success(t('admin.plugins.updateKeptOff')) }}
        />
      )}

      {depResolve && (
        <DependencyResolveDialog
          data={depResolve} t={t} busy={busy === depResolve.plugin.id} installedIds={installedIds}
          onDownload={(depId, constraint) => resolveDependency(depResolve.plugin, depId, constraint)}
          onClose={() => setDepResolve(null)}
        />
      )}
    </div>
  )
}

function statusLabel(s: StatusFilter, t: T): string {
  return s === 'all' ? t('admin.plugins.allStatuses') : s === 'on' ? t('admin.plugins.status.active')
    : s === 'off' ? t('admin.plugins.stateOff') : s === 'update' ? t('admin.plugins.filterUpdate') : t('admin.plugins.status.error')
}
function sortLabel(s: SortKey, t: T): string {
  return s === 'name' ? t('admin.plugins.sortName')
    : s === 'recent' ? t('admin.plugins.sortRecent')
    : s === 'downloads' ? t('admin.plugins.sortDownloads')
    : t('admin.plugins.sortUpdates')
}

function SegBtn({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button type="button" onClick={onClick} role="tab" aria-selected={active}
      className={`inline-flex items-center gap-2 text-[13px] font-medium px-3.5 py-1.5 rounded-lg transition-colors ${
        active ? 'bg-surface-card text-content shadow-card' : 'text-content-muted hover:text-content'}`}>
      {label}
      {count != null && (
        <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[11px] font-bold tabular-nums ${
          active ? 'bg-accent text-accent-text' : 'bg-surface-card text-content-muted'}`}>{count}</span>
      )}
    </button>
  )
}

function FilterMenu({ id, label, valueLabel, options, onPick, value, menu, setMenu, icon }: {
  id: string; label: string; valueLabel: string
  options: Array<[string, string]>; onPick: (v: string) => void; value: string
  menu: string | null; setMenu: (v: string | null) => void; icon?: React.ReactNode
}) {
  const open = menu === id
  const active = value !== options[0]?.[0]
  return (
    <div className="relative">
      <button type="button" onClick={() => setMenu(open ? null : id)} title={`${label}: ${valueLabel}`}
        className={`relative h-[38px] w-[38px] sm:w-auto px-0 sm:px-3 inline-flex items-center justify-center sm:justify-start gap-1.5 rounded-xl border bg-surface-card text-[13px] text-content-secondary transition-colors whitespace-nowrap hover:border-content-faint ${
          active ? 'border-content-faint' : 'border-edge'}`}>
        {icon}
        <span className="hidden sm:inline">{label}: </span>
        <span className="hidden sm:inline font-semibold text-content">{valueLabel}</span>
        <ChevronDown size={13} className={`hidden sm:block transition-transform ${open ? 'rotate-180' : ''}`} />
        {active && <span className="sm:hidden absolute -top-1 -right-1 w-2 h-2 rounded-full bg-accent ring-2 ring-surface-card" />}
      </button>
      {open && (
        <div className="absolute top-11 right-0 z-30 min-w-[180px] max-w-[calc(100vw-2rem)] p-1.5 rounded-xl border border-edge bg-surface-card shadow-elevated">
          {options.map(([v, lbl]) => (
            <button type="button" key={v} onClick={() => { onPick(v); setMenu(null) }}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] transition-colors hover:bg-surface-tertiary ${
                value === v ? 'text-content font-semibold' : 'text-content-secondary'}`}>
              {lbl}<Check size={15} className={`ml-auto text-accent ${value === v ? 'opacity-100' : 'opacity-0'}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyState({ t, onDiscover }: { t: T; onDiscover: () => void }) {
  return (
    <div className="py-16 text-center">
      <div className="w-14 h-14 rounded-2xl bg-surface-tertiary grid place-items-center mx-auto mb-4">
        <PackageOpen size={26} className="text-content-faint" />
      </div>
      <p className="text-sm font-medium text-content-muted">{t('admin.plugins.empty')}</p>
      <button type="button" onClick={onDiscover} className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-lg bg-accent text-accent-text">
        <Download size={14} /> {t('admin.plugins.tabDiscover')}
      </button>
    </div>
  )
}

function InstalledRow({ p, t, busy, menu, setMenu, hasUpdate, latestVer, newerIncompatible, blocked, onToggle, onUpdate, onRestart, onChangeVersion, onResume, onReviewBlock, onErrors, onEgress, onSettings, onUninstall }: {
  p: PluginRow; t: T; busy: string | null; menu: string | null; setMenu: (v: string | null) => void
  hasUpdate: boolean; latestVer?: string; newerIncompatible: { version: string; range: string } | null; blocked: boolean
  onToggle: () => void; onUpdate: () => void; onRestart: () => void; onChangeVersion: () => void; onResume: () => void; onReviewBlock: () => void
  onErrors: () => void; onEgress: () => void; onSettings: () => void; onUninstall: () => void
}) {
  const caps = deriveCaps(parseJson<string[]>(p.permissions, []), parseJson<{ widget?: { slot?: string } }>(p.capabilities, {}), t)
  const deps = deriveDeps(p, t)
  const menuOpen = menu === `row:${p.id}`
  const menuBtnRef = useRef<HTMLButtonElement>(null)

  // The menu is portaled to <body> and positioned `fixed` against the ⋯ button,
  // because the row's ancestor (PageSidebar) is `overflow-hidden` and would clip
  // an in-flow `absolute` menu — losing Delete on the lower rows of a long list.
  // Re-anchor while the page moves under it.
  const [, reanchor] = useState(0)
  useEffect(() => {
    if (!menuOpen) return
    const onMove = () => reanchor(n => n + 1)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [menuOpen])

  return (
    <div className="group relative flex items-center gap-3 sm:gap-4 px-2.5 sm:px-3 py-3.5 rounded-2xl hover:bg-surface-secondary transition-colors">
      <div className="relative shrink-0">
        <div className="w-[46px] h-[46px] rounded-[13px] grid place-items-center bg-surface-tertiary border border-edge-secondary">
          <PluginIcon name={p.icon} size={22} className="text-content-secondary" />
        </div>
        <span className={`absolute -right-0.5 -bottom-0.5 w-[13px] h-[13px] rounded-full ring-[2.5px] ring-surface-card ${HEALTH[p.status] || HEALTH.inactive}`}
          title={t(`admin.plugins.status.${p.status}` as never)} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[14.5px] font-semibold tracking-[-.006em] text-content">{p.name}</span>
          {p.version && <span className="text-[11.5px] text-content-faint font-medium tabular-nums">v{p.version}</span>}
          {p.reviewed_at && <ReviewedBadge t={t} />}
          {p.source_repo === 'local:upload' && <SideloadedBadge t={t} />}
          {p.source_repo === 'local:link' && <DevLinkBadge t={t} />}
          {/* Registry plugins only — a sideloaded/dev-linked plugin already says something
              strictly stronger, and stacking "Unsigned" on top of it just dilutes the amber. */}
          {isRegistrySourced(p.source_repo) && <TrustBadge signed={!!p.signed} t={t} />}
        </div>
        {p.description && <p className="text-[12.5px] text-content-muted mt-0.5 truncate">{p.description}</p>}
        {/* A refused update leaves a WORKING plugin pinned at its old version — so this is
            its own row state, not an error state, and it persists until it is resolved
            rather than dying with the toast that first reported it. */}
        {blocked && p.updateBlock && (
          <div className="flex items-center gap-1.5 mt-1.5 text-[11.5px] text-warning">
            <ShieldAlert size={13} className="shrink-0" />
            <span className="truncate">{t('admin.plugins.updateBlocked', { reason: p.updateBlock.detail ?? p.updateBlock.code })}</span>
            <button type="button" onClick={onReviewBlock}
              className="shrink-0 font-semibold underline underline-offset-2 hover:opacity-80 transition-opacity">
              {t('admin.plugins.reviewBlock')}
            </button>
          </div>
        )}
        {/* A newer version this TREK can't run — informational, never a button: the fix
            is a TREK upgrade, so the row must not nag or offer a doomed install. */}
        {newerIncompatible && (
          <div className="flex items-center gap-1.5 mt-1.5 text-[11.5px] text-content-faint">
            <Info size={13} className="shrink-0" />
            <span className="truncate">{t('admin.plugins.newerNeedsTrek', { version: newerIncompatible.version, range: newerIncompatible.range })}</span>
          </div>
        )}
        {/* Held: the admin deliberately installed a non-latest version, so updates are
            paused rather than nagged — resuming is one click, right where the pause shows. */}
        {p.updateHold && (
          <div className="flex items-center gap-1.5 mt-1.5 text-[11.5px] text-content-faint">
            <PauseCircle size={13} className="shrink-0" />
            <span className="truncate">{t('admin.plugins.updatesHeld', { version: p.version ?? '' })}</span>
            <button type="button" onClick={onResume} disabled={busy === p.id}
              className="shrink-0 font-semibold underline underline-offset-2 hover:opacity-80 transition-opacity disabled:opacity-50">
              {t('admin.plugins.resumeUpdates')}
            </button>
          </div>
        )}
        {p.status === 'error' && p.last_error ? (
          <div className="flex items-center gap-1.5 mt-1.5 text-[11.5px] text-danger">
            <AlertTriangle size={13} className="shrink-0" /><span className="truncate">{p.last_error}</span>
          </div>
        ) : (caps.length > 0 || p.operatorEgress) && (
          <div className="hidden sm:flex items-center gap-1.5 flex-wrap mt-2">
            {caps.map((c, i) => (
              <span key={i} className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-[3px] rounded-md border ${
                c.net ? 'text-info border-info/25 bg-info-soft' : 'text-content-secondary border-edge-secondary bg-surface-tertiary'}`}>
                <c.icon size={12} className={c.net ? 'text-info' : 'text-content-muted'} />{c.label}
              </span>
            ))}
            {/* This plugin talks to a service only the OPERATOR can name (a self-hosted
                Gotify/ntfy), so its manifest can't list the host — the admin adds it.
                Actionable, and warning-toned until at least one host exists, because
                until then the plugin cannot reach anything and looks silently broken. */}
            {p.operatorEgress && (
              <button type="button"
                onClick={onEgress}
                title={t('admin.plugins.allowedHosts.hint')}
                className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-[3px] rounded-md border transition-colors ${
                  p.egressHostCount > 0
                    ? 'text-info border-info/25 bg-info-soft hover:border-info/50'
                    : 'text-warning border-warning/30 bg-warning-soft hover:border-warning/60'}`}
              >
                <Globe size={12} className={p.egressHostCount > 0 ? 'text-info' : 'text-warning'} />
                {p.egressHostCount > 0
                  ? t('admin.plugins.allowedHosts.count').replace('{n}', String(p.egressHostCount))
                  : t('admin.plugins.allowedHosts.add')}
              </button>
            )}
          </div>
        )}
        {deps.length > 0 && (
          <div className="hidden sm:flex items-center gap-1.5 flex-wrap mt-1.5">
            {deps.map((d, i) => (
              <span key={i} className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-[3px] rounded-md border ${
                d.blocked || d.warn ? 'text-warning border-warning/30 bg-warning-soft' : 'text-content-secondary border-edge-secondary bg-surface-tertiary'}`}>
                <d.icon size={12} className={d.blocked || d.warn ? 'text-warning' : 'text-content-muted'} />{d.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {hasUpdate && (
          <button type="button" onClick={onUpdate} disabled={busy === p.id} title={t('admin.plugins.updateTo', { version: latestVer })}
            className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold px-2 sm:px-2.5 py-1.5 rounded-full text-warning bg-warning-soft border border-warning/30 hover:opacity-90 transition-opacity disabled:opacity-50">
            <ArrowUpCircle size={13} /> <span className="hidden sm:inline">{t('admin.plugins.updateTo', { version: latestVer })}</span>
          </button>
        )}
        <span className={`hidden sm:inline text-xs font-medium min-w-[42px] text-right ${p.enabled === 1 && p.status !== 'error' ? 'text-content-secondary' : 'text-content-faint'}`}>
          {p.enabled === 1 ? t('admin.plugins.status.active') : t('admin.plugins.stateOff')}
        </span>
        <ToggleSwitch on={p.enabled === 1} label={t('admin.plugins.enabledToggle')} onToggle={onToggle} />
        <div className="relative">
          <button type="button" ref={menuBtnRef} data-testid={`plugin-row-menu-btn-${p.id}`} onClick={() => setMenu(menuOpen ? null : `row:${p.id}`)}
            className="w-[34px] h-[34px] grid place-items-center rounded-lg text-content-faint hover:text-content hover:bg-surface-tertiary transition-colors">
            <MoreHorizontal size={17} />
          </button>
          {menuOpen && createPortal(
            <div data-testid={`plugin-row-menu-${p.id}`} style={anchorMenu(menuBtnRef.current)}
              className="min-w-[180px] p-1.5 rounded-xl border border-edge bg-surface-card shadow-elevated">
              {p.enabled === 1 && (
                <MenuItem icon={<RotateCw size={14} />} label={t('admin.plugins.restart')} onClick={onRestart} />
              )}
              {/* A plugin gets the item if it declares scope:'instance' fields OR actions —
                  an action-only plugin still needs the dialog to run its buttons. */}
              {((p.instanceSettingsCount ?? 0) > 0 || (p.instanceActionsCount ?? 0) > 0) && (
                <MenuItem icon={<SlidersHorizontal size={14} />} label={t('admin.plugins.instanceSettings')} onClick={onSettings} />
              )}
              <MenuItem icon={<Bug size={14} />} label={t('admin.plugins.viewErrors')} onClick={onErrors} />
              {/* Only a plugin that DECLARED operatorEgress gets the item — an admin must
                  never be invited to widen egress for a plugin that didn't ask for it
                  (same rule the row's egress chip follows). */}
              {p.operatorEgress && (
                <MenuItem icon={<Globe size={14} />} label={t('admin.plugins.allowedHosts')} onClick={onEgress} />
              )}
              {/* Registry plugins only — a sideload/dev-link has no registry versions to pick from. */}
              {isRegistrySourced(p.source_repo) && (
                <MenuItem icon={<History size={14} />} label={t('admin.plugins.changeVersion')} onClick={onChangeVersion} />
              )}
              {p.source_repo && p.source_repo !== 'local:upload' && p.source_repo !== 'local:link' && (
                <>
                  <a href={`https://github.com/${p.source_repo}`} target="_blank" rel="noreferrer" onClick={() => setMenu(null)}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] text-content-secondary hover:bg-surface-tertiary transition-colors">
                    <Github size={14} /> {t('admin.plugins.sourceRepo')}
                  </a>
                  <a href={`https://github.com/${p.source_repo}/issues`} target="_blank" rel="noreferrer" onClick={() => setMenu(null)}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] text-content-secondary hover:bg-surface-tertiary transition-colors">
                    <CircleDot size={14} /> {t('admin.plugins.reportIssue')}
                  </a>
                </>
              )}
              <div className="my-1 border-t border-edge-secondary" />
              <MenuItem icon={<Trash2 size={14} />} label={t('common.delete')} danger onClick={onUninstall} />
            </div>,
            document.body,
          )}
        </div>
      </div>
    </div>
  )
}

/** Tallest the ⋯ menu gets (6 items + divider + padding). Drives the flip. */
const ROW_MENU_MAX_H = 260

/** Pin a portaled menu to the right edge of its trigger, flipping up when the bottom is tight. */
function anchorMenu(trigger: HTMLElement | null): CSSProperties {
  const r = trigger?.getBoundingClientRect()
  if (!r) return { position: 'fixed', top: 0, right: 0, zIndex: 100 }
  const spaceBelow = window.innerHeight - r.bottom
  const openUp = spaceBelow < ROW_MENU_MAX_H && r.top > spaceBelow
  return {
    position: 'fixed',
    right: Math.max(8, window.innerWidth - r.right),
    ...(openUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    zIndex: 100,
  }
}

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] transition-colors ${
        danger ? 'text-danger hover:bg-danger-soft' : 'text-content-secondary hover:bg-surface-tertiary'}`}>
      {icon} {label}
    </button>
  )
}

function Screenshot({ url, className, iconSize = 28 }: { url: string | null; className: string; iconSize?: number }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className={`bg-surface-tertiary overflow-hidden ${className}`}>
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" className="w-full h-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <div className="w-full h-full grid place-items-center bg-gradient-to-br from-surface-tertiary to-surface-secondary">
          <Blocks size={iconSize} className="text-content-faint/50" />
        </div>
      )}
    </div>
  )
}

function RegistryGrid({ items, onInstall, onOpenDetail, busy, t, installedIds, filtered, ignoreTrekRange }: {
  items: RegistryItem[] | null
  onInstall: (id: string, version?: string, warn?: RangeWarning) => void
  onOpenDetail: (item: RegistryItem) => void
  busy: string | null
  t: T
  installedIds: Set<string>
  filtered: boolean
  ignoreTrekRange: boolean
}) {
  if (!items) return <div className="py-14 text-center text-sm text-content-faint">{t('common.loading')}</div>
  if (items.length === 0) return (
    <div className="py-14 text-center">
      <Search size={26} className="text-content-faint/60 mx-auto mb-3" />
      <p className="text-sm text-content-faint">{filtered ? t('admin.plugins.noMatchRegistry') : t('admin.plugins.registryEmpty')}</p>
    </div>
  )
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 sm:gap-4 px-4 sm:px-6 pb-5 pt-1">
      {items.map(item => {
        const installed = installedIds.has(item.id)
        const offer = installOffer(item, t, ignoreTrekRange)
        return (
          <div key={item.id} role="button" tabIndex={0} onClick={() => onOpenDetail(item)}
            // No press-scale on the card: shrinking it mid-click slides the Install
            // button out from under the pointer, so the click retargets onto the card
            // and opens the detail modal instead of installing (#2158).
            data-no-press
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenDetail(item) } }}
            className="group border border-edge rounded-2xl bg-surface-card overflow-hidden flex flex-col cursor-pointer hover:-translate-y-0.5 hover:shadow-elevated hover:border-edge-faint transition-all duration-150">
            <div className="relative">
              <Screenshot url={item.screenshotUrl} className="aspect-[16/10]" iconSize={24} />
              <div className="absolute inset-0 bg-gradient-to-t from-black/45 to-transparent" />
              {item.reviewedAt && (
                <span className="absolute top-2.5 right-2.5 inline-flex items-center gap-1 text-[10.5px] font-semibold text-white bg-black/40 backdrop-blur-sm rounded-full px-2 py-1">
                  <ShieldCheck size={12} /> {t('admin.plugins.reviewed')}
                </span>
              )}
              <div className="absolute left-3 -bottom-4 w-11 h-11 rounded-xl bg-surface-card border border-edge grid place-items-center shadow-card z-[1]">
                <PluginIcon name={item.icon} size={22} className="text-content-secondary" />
              </div>
            </div>
            <div className="pt-6 px-3.5 pb-3.5 flex flex-col flex-1">
              <span className="text-sm font-semibold tracking-[-.006em] text-content truncate">{item.name}</span>
              <span className="text-[11.5px] text-content-faint mt-0.5">{item.author}</span>
              <p className="text-xs text-content-muted mt-2 line-clamp-2 flex-1">{item.description}</p>
              <div className="flex items-center gap-2 mt-3 flex-wrap">
                <TypeBadge type={item.type} t={t} />
                {/* Everything in Discover is registry-sourced, so the badge always applies. */}
                <TrustBadge signed={!!item.signed} t={t} />
                {item.latest && <span className="text-[10.5px] text-content-faint tabular-nums">v{item.latest}</span>}
                {typeof item.downloadCount === 'number' && item.downloadCount > 0 && (
                  <span className="inline-flex items-center gap-1 text-[10.5px] text-content-faint tabular-nums" title={t('admin.plugins.downloads')}>
                    <Download size={11} /> {formatCompactCount(item.downloadCount)}
                  </span>
                )}
                <button type="button" onClick={e => { e.stopPropagation(); onInstall(item.id, offer.version, offer.warn) }}
                  disabled={busy === item.id || installed || offer.blocked}
                  title={installed ? undefined : offer.title}
                  className="ml-auto text-xs font-semibold px-3.5 py-1.5 rounded-lg bg-accent text-accent-text hover:bg-accent-hover disabled:opacity-50 disabled:bg-surface-tertiary disabled:text-content-faint transition-colors">
                  {installed ? t('admin.plugins.installed') : offer.label}
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// 1234 -> "1.2k" — GitHub-style compact download counts for the browse cards.
// The M threshold sits at the k-rounding boundary so 999 950 is "1M", not "1000k".
function formatCompactCount(n: number): string {
  if (n >= 999_500) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`
  return String(n)
}

// A permission rendered human-readable when known, else as its raw code.
function PermLabel({ perm, t }: { perm: string; t: T }) {
  return PERM_KEYS.includes(perm)
    ? <span>{t(`admin.plugins.perm.${perm}` as never)}</span>
    : <code className="font-mono text-[11px] bg-surface-tertiary px-1.5 py-0.5 rounded">{perm}</code>
}

/**
 * The TREK_PLUGINS_IGNORE_TREK_RANGE warning (copy and modes from useRangeBypass). Its own
 * component rather than ConfirmDialog because the notice mode has no cancel button.
 */
function RangeBypassDialog({ copy: { title, body, confirm }, onConfirm, onClose, t }: {
  copy: { title: string; body: string; confirm: boolean }; onConfirm: () => void; onClose: () => void; t: T
}) {
  return createPortal(
    <div role="presentation" className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title}
        className="bg-surface-card border border-edge rounded-2xl w-full max-w-md p-6 shadow-modal" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-4">
          <div className="shrink-0 w-10 h-10 rounded-full bg-warning-soft grid place-items-center">
            <AlertTriangle size={20} className="text-warning" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-content">{title}</h3>
            <p className="mt-1.5 text-sm text-content-secondary leading-relaxed">{body}</p>
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          {confirm ? (
            <>
              <button type="button" onClick={onClose}
                className="px-4 py-2 text-sm font-medium rounded-lg text-content-secondary border border-edge-secondary transition-colors">
                {t('common.cancel')}
              </button>
              <button type="button" onClick={onConfirm}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-warning text-white hover:opacity-90 transition-opacity">
                {t('admin.plugins.installAnyway')}
              </button>
            </>
          ) : (
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-accent text-accent-text hover:bg-accent-hover transition-colors">
              {t('common.ok')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function PluginDetailModal({ item, installed, busy, onInstall, onClose, t, locale, ignoreTrekRange }: {
  item: RegistryItem; installed: boolean; busy: string | null; ignoreTrekRange: boolean
  onInstall: (id: string, version?: string, warn?: RangeWarning) => void; onClose: () => void; t: T; locale: string
}) {
  const [detail, setDetail] = useState<RegistryDetail | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    adminApi.pluginDetail(item.id)
      .then((d: RegistryDetail) => { if (alive) setDetail(d) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [item.id])

  const manifest = detail?.manifest ?? null
  const permissions = manifest?.permissions ?? []
  const egress = manifest?.egress ?? []
  const settings = manifest?.settings ?? []
  const caps = manifest ? deriveCaps(permissions, manifest.capabilities ?? {}, t) : []
  const repoUrl = `https://github.com/${item.repo}`
  const homepage = item.homepage && /^https?:\/\//i.test(item.homepage) && item.homepage !== repoUrl ? item.homepage : null
  const sizeKb = detail?.size ? Math.max(1, Math.round(detail.size / 1024)) : null
  // The detail fetch carries the same compat verdict as the browse list; prefer it once
  // it lands (it is keyed to the same entry) and fall back to the grid item until then.
  const offer = installOffer(detail ?? item, t, ignoreTrekRange)

  return (
    <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="presentation" className="bg-surface-card border border-edge rounded-2xl w-full max-w-xl max-h-[88vh] overflow-auto shadow-modal" onClick={e => e.stopPropagation()}>
        <div className="relative">
          <Screenshot url={item.screenshotUrl} className="w-full aspect-[16/9]" iconSize={36} />
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
          <button type="button" onClick={onClose} className="absolute top-3 right-3 w-8 h-8 grid place-items-center rounded-lg bg-black/40 text-white hover:bg-black/60 transition-colors"><X size={16} /></button>
        </div>

        <div className="flex items-start gap-3 sm:gap-3.5 px-4 sm:px-5 -mt-7 relative z-[1]">
          <div className="w-14 h-14 rounded-[15px] bg-surface-card border border-edge grid place-items-center shadow-card shrink-0">
            <PluginIcon name={manifest?.icon ?? null} size={28} className="text-content-secondary" />
          </div>
          <div className="flex-1 min-w-0 pt-8">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-lg font-semibold tracking-tight text-content">{item.name}</h3>
              {item.reviewedAt && <ReviewedBadge t={t} />}
            </div>
            <p className="text-[12.5px] text-content-faint mt-0.5">{item.author}{item.latest ? ` · v${item.latest}` : ''}</p>
          </div>
          <button type="button" onClick={() => onInstall(item.id, offer.version, offer.warn)}
            disabled={busy === item.id || installed || offer.blocked}
            title={installed ? undefined : offer.title}
            className="self-end text-[13px] font-semibold px-3 sm:px-4 py-2 rounded-lg bg-accent text-accent-text hover:bg-accent-hover disabled:opacity-50 disabled:bg-surface-tertiary disabled:text-content-faint transition-colors shrink-0">
            {installed ? t('admin.plugins.installed') : offer.label}
          </button>
        </div>

        <div className="px-4 sm:px-5 pt-4 pb-5">
          <p className="text-[13.5px] text-content-secondary leading-relaxed">{item.description}</p>
          {failed && <p className="text-xs text-danger mt-3">{t('admin.plugins.detailError')}</p>}
          {/* The reason the button is blocked (or offering an older version) — a tooltip
              alone would leave a touch user with a dead button and no explanation. */}
          {offer.title && !installed && (
            <p className="flex items-start gap-1.5 text-xs text-warning bg-warning-soft border border-warning/25 rounded-lg px-2.5 py-2 mt-3">
              <AlertTriangle size={13} className="shrink-0 mt-[1px]" /> {offer.title}
            </p>
          )}

          {manifest && (
            <div className="mt-5">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">{t('admin.plugins.accessTitle')}</h4>
              {caps.filter(c => !c.net).length === 0 && !permissions.includes('db:own') ? (
                <p className="text-xs text-content-faint mt-2">{t('admin.plugins.noAccess')}</p>
              ) : (
                <div className="mt-2 space-y-1.5">
                  {caps.filter(c => !c.net).map((c, i) => (
                    <div key={i} className="flex items-start gap-2.5 text-[13px] text-content-secondary py-0.5">
                      <c.icon size={15} className="text-accent mt-0.5 shrink-0" /><span>{c.label}</span>
                    </div>
                  ))}
                  {permissions.includes('db:own') && (
                    <div className="flex items-start gap-2.5 text-[13px] text-content-secondary py-0.5">
                      <Database size={15} className="text-accent mt-0.5 shrink-0" /><span>{t('admin.plugins.perm.db:own')}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* The tool text a plugin publishes goes straight into every user's
              assistant context once mcp:tools is granted, and nothing else in
              this dialog shows it. An admin approving the grant should read the
              names and descriptions first, not discover them in a chat. */}
          {manifest && (manifest.capabilities?.mcpTools?.length ?? 0) > 0 && (
            <div className="mt-5">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">{t('admin.plugins.mcpToolsTitle')}</h4>
              <ul className="mt-2 space-y-1.5">
                {(manifest.capabilities?.mcpTools ?? []).map(tool => (
                  <li key={tool.name} className="flex items-start gap-2.5 py-0.5">
                    <Bot size={15} className="text-accent mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <code className="text-[12px] font-mono text-content">{tool.name}</code>
                      {tool.title && <p className="text-[12.5px] font-medium text-content leading-snug">{tool.title}</p>}
                      {/* The description is the assistant-facing text: it is what the
                          model reads to decide whether to call the tool, so it is the
                          line an admin most needs to see. Never hidden behind a title. */}
                      <p className="text-[12.5px] text-content-secondary leading-snug">{tool.description}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="text-[11.5px] text-content-faint mt-2">{t('admin.plugins.mcpToolsHint')}</p>
            </div>
          )}

          {manifest && (egress.length > 0 || manifest.operatorEgress) && (
            <div className="mt-5">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">{t('admin.plugins.connectsTitle')}</h4>
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                {egress.map(h => (
                  <code key={h} className="text-[12px] font-mono text-info bg-info-soft rounded-md px-2 py-1">{h}</code>
                ))}
                {/* The hosts above are NOT the whole story for this plugin: it talks to a
                    service only the operator can name, so its reach is whatever an admin
                    adds after install. Say so HERE — this is the pre-install review, and a
                    reviewer who reads only the host list would otherwise be misled. */}
                {manifest.operatorEgress && (
                  <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-warning bg-warning-soft border border-warning/30 rounded-md px-2 py-1">
                    <Globe size={12} />{t('admin.plugins.operatorEgressPill')}
                  </span>
                )}
              </div>
              {manifest.operatorEgress && (
                <p className="text-[11.5px] text-content-faint mt-2">{t('admin.plugins.operatorEgressHint')}</p>
              )}
            </div>
          )}

          {manifest && settings.length > 0 && (
            <div className="mt-5">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">{t('admin.plugins.setupTitle')}</h4>
              <ul className="mt-2 space-y-1.5">
                {settings.map(s => (
                  <li key={s.key} className="flex items-center gap-2 text-xs text-content-muted flex-wrap">
                    <span className="font-medium">{s.label}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-tertiary text-content-faint">{t(`admin.plugins.scope.${s.scope}` as never)}</span>
                    {s.required && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-warning-soft text-warning">{t('admin.plugins.fieldRequired')}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-5">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">{t('admin.plugins.detailsTitle')}</h4>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 mt-2.5">
              {item.latest && <Meta k={t('admin.plugins.metaVersion')} v={`v${item.latest}`} />}
              {sizeKb !== null && <Meta k={t('admin.plugins.metaSize')} v={`${sizeKb} KB`} />}
              {/* The range, not just its lower bound: "TREK 3.2.0+" reads as "and anything
                  newer", which is exactly the claim a `<4.0.0` upper bound denies. */}
              {(item.trek || item.minTrekVersion) && (
                <Meta k={t('admin.plugins.metaRequires')} v={item.trek ? `TREK ${item.trek}` : `TREK ${item.minTrekVersion}+`} />
              )}
              {item.reviewedAt && <Meta k={t('admin.plugins.metaReviewed')} v={new Date(item.reviewedAt).toLocaleDateString(locale)} />}
              {typeof item.downloadCount === 'number' && item.downloadCount > 0 && (
                <Meta k={t('admin.plugins.downloads')} v={item.downloadCount.toLocaleString(locale)} />
              )}
            </div>
          </div>

          {/* Every published version, installable individually. The compat verdict per
              version is SERVER-computed — an incompatible one is explained, never offered. */}
          {(detail?.versions?.length ?? 0) > 1 && (
            <div className="mt-5">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">{t('admin.plugins.versionsTitle')}</h4>
              <div className="mt-2 space-y-0.5">
                {detail!.versions!.map(v => (
                  <div key={v.version} className="flex items-center gap-2.5 py-1">
                    <span className={`text-[12.5px] font-medium tabular-nums ${v.compatible ? 'text-content' : 'text-content-faint'}`}>v{v.version}</span>
                    {v.publishedAt && <span className="text-[11.5px] text-content-faint">{new Date(v.publishedAt).toLocaleDateString(locale)}</span>}
                    {v.signed && <ShieldCheck size={13} className="text-success shrink-0" />}
                    <span className="ml-auto" />
                    {v.compatible ? (
                      !installed && (
                        <button type="button" onClick={() => onInstall(item.id, v.version)} disabled={busy === item.id}
                          className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full border border-edge bg-surface-card text-content-secondary hover:text-content hover:border-content-faint transition-colors disabled:opacity-50">
                          {t('admin.plugins.installCompatible', { version: v.version })}
                        </button>
                      )
                    ) : (
                      <span className="text-[11.5px] text-content-faint">{t('admin.plugins.versionNeedsTrek', { range: v.trek ?? '' })}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 sm:px-5 py-3.5 border-t border-edge-secondary bg-surface-secondary">
          <a href={repoUrl} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-edge bg-surface-card text-content-secondary hover:text-content hover:border-content-faint transition-colors">
            <Github size={13} /> {t('admin.plugins.sourceRepo')}
          </a>
          <a href={`${repoUrl}/issues`} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-edge bg-surface-card text-content-secondary hover:text-content hover:border-content-faint transition-colors">
            <CircleDot size={13} /> {t('admin.plugins.reportIssue')}
          </a>
          {homepage && (
            <a href={homepage} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-edge bg-surface-card text-content-secondary hover:text-content hover:border-content-faint transition-colors">
              <ExternalLink size={13} /> {t('admin.plugins.homepage')}
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

function Meta({ k, v }: { k: string; v: string }) {
  return <div><div className="text-[12px] text-content-faint">{k}</div><div className="text-[12.5px] font-medium text-content mt-0.5">{v}</div></div>
}

/**
 * "Change version…" for an INSTALLED plugin. Rows render the server's per-version compat
 * verdict: the installed version is marked, a compatible one gets a Switch action (the
 * caller routes a DOWNGRADE through the data-risk confirm), an incompatible one is
 * explained and never offered.
 */
function VersionPickerDialog({ plugin, versions, failed, busy, t, locale, onPick, onClose }: {
  plugin: PluginRow; versions: VersionInfo[] | null; failed: boolean; busy: string | null
  t: T; locale: string; onPick: (version: string) => void; onClose: () => void
}) {
  return (
    <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="presentation" className="bg-surface-card border border-edge rounded-2xl w-full max-w-md max-h-[80vh] overflow-auto shadow-modal" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-edge-secondary">
          <h3 className="text-[15px] font-semibold text-content truncate">{t('admin.plugins.versionPickerTitle', { name: plugin.name })}</h3>
          <button type="button" onClick={onClose} className="w-8 h-8 grid place-items-center rounded-lg text-content-faint hover:text-content hover:bg-surface-tertiary transition-colors shrink-0"><X size={16} /></button>
        </div>
        <div className="p-2">
          {failed && <p className="text-xs text-danger px-2.5 py-2">{t('admin.plugins.detailError')}</p>}
          {!failed && !versions && <p className="text-xs text-content-faint px-2.5 py-2">{t('common.loading')}</p>}
          {versions?.length === 0 && <p className="text-xs text-content-faint px-2.5 py-2">{t('admin.plugins.noVersions')}</p>}
          {versions?.map(v => {
            const current = v.version === plugin.version
            return (
              <div key={v.version} data-testid={`version-row-${v.version}`}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-xl hover:bg-surface-secondary transition-colors">
                <span className={`text-[13px] font-medium tabular-nums ${v.compatible ? 'text-content' : 'text-content-faint'}`}>v{v.version}</span>
                {v.publishedAt && <span className="text-[11.5px] text-content-faint">{new Date(v.publishedAt).toLocaleDateString(locale)}</span>}
                {v.signed && <ShieldCheck size={13} className="text-success shrink-0" />}
                <span className="ml-auto" />
                {current ? (
                  <span className="text-[11.5px] font-medium text-content-faint">{t('admin.plugins.installed')}</span>
                ) : v.compatible ? (
                  <button type="button" onClick={() => onPick(v.version)} disabled={busy === plugin.id}
                    className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full border border-edge bg-surface-card text-content-secondary hover:text-content hover:border-content-faint transition-colors disabled:opacity-50">
                    {t('admin.plugins.versionSwitch', { version: v.version })}
                  </button>
                ) : (
                  <span className="text-[11.5px] text-content-faint">{t('admin.plugins.versionNeedsTrek', { range: v.trek ?? '' })}</span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * A signature check refused an install/update.
 *
 * The override lives here, and it is scoped to exactly one code. A rotated key has a
 * benign explanation — the author rotated it, or lost it and made a new one. A signature
 * that does NOT verify does not: it means the bytes are not what the author signed, which
 * is corruption or an attack, and there is no story where the right answer is "let the
 * admin wave it through". So SIGNATURE_INVALID / _MISSING / _INCOMPLETE get a clear
 * explanation and no override button AT ALL — not a disabled one, not one behind a
 * confirm. The absence of an escape hatch is the feature.
 *
 * (The server enforces this too — it re-derives the condition and refuses anything but a
 * changed key. This dialog is the convenience, not the control.)
 */
function SignatureBlockDialog({ data, entry, busy, t, onRetrust, onClose }: {
  data: { subject: SigSubject; code: string; detail: string | null }
  entry: RegistryItem | undefined
  busy: boolean; t: T
  onRetrust: (version: string, publicKey: string) => void
  onClose: () => void
}) {
  const canRetrust = data.code === RETRUSTABLE
  const newKey = entry?.authorPublicKey ?? null
  const version = entry?.latest ?? null
  // Only offer the override when we actually hold the new key + version to send: the
  // request carries both, and the server compares the key exactly.
  const offerRetrust = canRetrust && !!newKey && !!version

  const bodyKey = data.code === RETRUSTABLE ? 'admin.plugins.sig.keyChangedBody'
    : data.code === 'SIGNATURE_MISSING' ? 'admin.plugins.sig.missingBody'
    : data.code === 'SIGNATURE_INCOMPLETE' ? 'admin.plugins.sig.incompleteBody'
    : 'admin.plugins.sig.invalidBody'

  return (
    <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="presentation" className="bg-surface-card border border-edge rounded-2xl w-full max-w-md max-h-[88vh] flex flex-col shadow-modal overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="shrink-0 px-5 py-4 border-b border-edge-secondary flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-warning-soft grid place-items-center shrink-0"><ShieldAlert size={18} className="text-warning" /></div>
          <div>
            <h3 className="text-sm font-semibold text-content">{t('admin.plugins.sig.title', { name: data.subject.name })}</h3>
            <p className="text-xs text-content-muted mt-1">{t(bodyKey as never)}</p>
          </div>
        </div>
        <div className="p-5 space-y-4 min-h-0 flex-1 overflow-y-auto">
          {/* Fingerprints, not full keys: these exist to be COMPARED by a human — read the
              new one back to the author over the phone. The full key travels in the request. */}
          {canRetrust && (
            <div className="space-y-2">
              <KeyRow label={t('admin.plugins.sig.pinnedKey')} value={data.subject.keyFingerprint ?? '—'} />
              <KeyRow label={t('admin.plugins.sig.newKey')} value={fingerprint(newKey) ?? '—'} highlight />
              <p className="text-[11.5px] text-content-muted leading-relaxed pt-1">{t('admin.plugins.sig.confirmOutOfBand')}</p>
            </div>
          )}
          {!canRetrust && data.detail && (
            <p className="text-xs text-content-faint font-mono break-all bg-surface-tertiary rounded-lg px-3 py-2">{data.detail}</p>
          )}
        </div>
        <div className="shrink-0 px-5 py-3.5 border-t border-edge-secondary bg-surface-secondary flex items-center justify-end gap-2">
          <button type="button" onClick={onClose}
            className="text-xs font-medium px-3.5 py-2 rounded-lg border border-edge text-content-muted hover:text-content hover:bg-surface-tertiary transition-colors">
            {offerRetrust ? t('admin.plugins.sig.cancel') : t('common.close')}
          </button>
          {offerRetrust && (
            <button type="button" onClick={() => onRetrust(version, newKey)} disabled={busy}
              className="text-xs font-semibold px-4 py-2 rounded-lg bg-warning text-white hover:opacity-90 transition-opacity disabled:opacity-50">
              {t('admin.plugins.sig.retrustConfirm')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function KeyRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-edge-secondary bg-surface-tertiary px-3 py-2">
      <span className="text-[11.5px] text-content-muted shrink-0">{label}</span>
      <code className={`font-mono text-[12px] break-all ${highlight ? 'text-warning font-semibold' : 'text-content'}`}>{value}</code>
    </div>
  )
}

/** Client-side twin of the server's fingerprint: head…tail of the base64 payload. Display
 * only — every equality check that matters happens server-side against the full key. */
function fingerprint(key: string | null): string | null {
  if (!key) return null
  const payload = key.trim().split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('untrusted comment')).pop()
  if (!payload) return null
  return payload.length <= 20 ? payload : `${payload.slice(0, 8)}…${payload.slice(-8)}`
}

function UpdateConsentDialog({ data, unsigned, t, onApprove, onLater }: {
  data: { plugin: PluginRow; version: string; newPermissions: string[]; newEgress: string[] }
  unsigned: boolean
  t: T; onApprove: () => void; onLater: () => void
}) {
  return (
    <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onLater}>
      <div role="presentation" className="bg-surface-card border border-edge rounded-2xl w-full max-w-md max-h-[88vh] flex flex-col shadow-modal overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="shrink-0 px-5 py-4 border-b border-edge-secondary flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-warning-soft grid place-items-center shrink-0"><ShieldCheck size={18} className="text-warning" /></div>
          <div>
            <h3 className="text-sm font-semibold text-content">{t('admin.plugins.updateConsentTitle')}</h3>
            <p className="text-xs text-content-muted mt-1">{t('admin.plugins.updateConsentBody', { name: data.plugin.name, version: data.version })}</p>
          </div>
        </div>
        <div className="p-5 space-y-4 min-h-0 flex-1 overflow-y-auto">
          {/* The admin is about to widen what this code may do — so say, right here, that
              nothing ties this code to its author. One line, no checkbox, no extra click:
              this informs, it does not block. */}
          {unsigned && (
            <p className="flex items-start gap-2 text-xs text-warning bg-warning-soft border border-warning/25 rounded-lg px-3 py-2">
              <ShieldAlert size={13} className="mt-0.5 shrink-0" />
              <span>{t('admin.plugins.sig.consentUnsigned')}</span>
            </p>
          )}
          {data.newPermissions.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-content-muted">{t('admin.plugins.updateNewPermissions')}</h4>
              <ul className="mt-2 space-y-1.5">
                {data.newPermissions.map(perm => (
                  <li key={perm} className="flex items-start gap-2 text-xs text-content-muted"><Check size={13} className="text-warning mt-0.5 shrink-0" /><PermLabel perm={perm} t={t} /></li>
                ))}
              </ul>
            </div>
          )}
          {data.newEgress.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-content-muted">{t('admin.plugins.updateNewEgress')}</h4>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.newEgress.map(host => <code key={host} className="font-mono text-[11px] bg-surface-tertiary px-1.5 py-0.5 rounded text-content-muted">{host}</code>)}
              </div>
            </div>
          )}
        </div>
        <div className="shrink-0 px-5 py-3.5 border-t border-edge-secondary bg-surface-secondary flex items-center justify-end gap-2">
          <button type="button" onClick={onLater} className="text-xs font-medium px-3.5 py-2 rounded-lg border border-edge text-content-muted hover:text-content hover:bg-surface-tertiary transition-colors">{t('admin.plugins.updateLater')}</button>
          <button type="button" onClick={onApprove} className="text-xs font-semibold px-4 py-2 rounded-lg bg-accent text-accent-text hover:bg-accent-hover transition-colors">{t('admin.plugins.updateApprove')}</button>
        </div>
      </div>
    </div>
  )
}

// Shown when enabling a plugin is blocked by missing/outdated plugin dependencies.
// Each dependency gets a one-click download (latest version satisfying its range,
// transitively) that then retries enabling the plugin.
function DependencyResolveDialog({ data, t, busy, installedIds, onDownload, onClose }: {
  data: { plugin: PluginRow; missing: PluginDep[]; versionMismatch: VersionMismatch[] }
  t: T; busy: boolean; installedIds: Set<string>
  onDownload: (depId: string, constraint?: string) => void; onClose: () => void
}) {
  const rows: Array<{ id: string; constraint: string; installed?: string }> = [
    ...data.missing.map(d => ({ id: d.id, constraint: d.version })),
    ...data.versionMismatch.map(d => ({ id: d.id, constraint: d.wanted, installed: d.installed })),
  ]
  return (
    <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="presentation" className="bg-surface-card border border-edge rounded-2xl w-full max-w-md max-h-[88vh] flex flex-col shadow-modal overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="shrink-0 px-5 py-4 border-b border-edge-secondary flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-warning-soft grid place-items-center shrink-0"><Puzzle size={18} className="text-warning" /></div>
          <div>
            <h3 className="text-sm font-semibold text-content">{t('admin.plugins.dep.resolveTitle')}</h3>
            <p className="text-xs text-content-muted mt-1">{t('admin.plugins.dep.resolveBody', { name: data.plugin.name })}</p>
          </div>
        </div>
        <div className="p-5 space-y-2.5 min-h-0 flex-1 overflow-y-auto">
          {rows.map(r => (
            <div key={r.id} className="flex items-center gap-3 p-3 rounded-xl border border-edge-secondary bg-surface-tertiary">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-content truncate">{r.id}</div>
                <div className="text-[11.5px] text-content-muted mt-0.5">
                  {r.installed
                    ? t('admin.plugins.dep.mismatch', { wanted: r.constraint, installed: r.installed })
                    : t('admin.plugins.dep.requires', { version: r.constraint })}
                </div>
              </div>
              <button type="button" onClick={() => onDownload(r.id, r.constraint)} disabled={busy}
                className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold px-3 py-1.5 rounded-full bg-accent text-accent-text hover:bg-accent-hover transition-colors disabled:opacity-50 shrink-0">
                <Download size={13} /> {r.installed ? t('admin.plugins.dep.update') : t('admin.plugins.dep.download')}
              </button>
            </div>
          ))}
          {rows.some(r => !installedIds.has(r.id)) && (
            <p className="text-[11.5px] text-content-faint pt-1">{t('admin.plugins.dep.resolveHint')}</p>
          )}
        </div>
        <div className="shrink-0 px-5 py-3.5 border-t border-edge-secondary bg-surface-secondary flex items-center justify-end">
          <button type="button" onClick={onClose} className="text-xs font-medium px-3.5 py-2 rounded-lg border border-edge text-content-muted hover:text-content hover:bg-surface-tertiary transition-colors">{t('common.cancel')}</button>
        </div>
      </div>
    </div>
  )
}

// Footer: a plain-language note on what "Reviewed" means, plus a collapsible
// panel that lays out how plugins are contained, the limits, and the worst case.
function SecurityInfo({ t }: { t: T }) {
  const [open, setOpen] = useState(false)
  const sections: Array<[string, string]> = [
    ['admin.plugins.security.isolationTitle', 'admin.plugins.security.isolationBody'],
    ['admin.plugins.security.permsTitle', 'admin.plugins.security.permsBody'],
    ['admin.plugins.security.limitsTitle', 'admin.plugins.security.limitsBody'],
    ['admin.plugins.security.worstTitle', 'admin.plugins.security.worstBody'],
    ['admin.plugins.security.reviewedTitle', 'admin.plugins.security.reviewedBody'],
    ['admin.plugins.security.signedTitle', 'admin.plugins.security.signedBody'],
    ['admin.plugins.security.trustTitle', 'admin.plugins.security.trustBody'],
  ]
  return (
    <div className="border-t border-edge-secondary bg-surface-secondary rounded-b-2xl overflow-hidden">
      <div className="px-4 sm:px-6 py-3.5 flex items-start gap-2">
        <ShieldCheck size={14} className="text-content-faint shrink-0 mt-0.5" />
        <p className="text-xs text-content-muted">{t('admin.plugins.reviewedMeaning')}</p>
      </div>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full px-4 sm:px-6 py-2.5 border-t border-edge-secondary flex items-center justify-between gap-2 text-xs font-medium text-content-secondary hover:text-content hover:bg-surface-tertiary transition-colors">
        <span className="flex items-center gap-2"><Lock size={13} className="shrink-0" /> <span className="text-left">{t('admin.plugins.security.title')}</span></span>
        <ChevronDown size={15} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 sm:px-6 py-4 border-t border-edge-secondary grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {sections.map(([h, b]) => (
            <div key={h}>
              <h4 className="text-[12.5px] font-semibold text-content">{t(h as never)}</h4>
              <p className="text-xs text-content-muted mt-1 leading-relaxed">{t(b as never)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
