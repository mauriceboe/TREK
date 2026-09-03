import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { PLUGIN_PERMISSIONS } from '@trek/shared'
import {
  Blocks, AlertTriangle, PackageOpen, RefreshCw, Trash2, Download, Bug, X, ShieldCheck, UploadCloud,
  ArrowUpCircle, Github, ExternalLink, ChevronDown, Check, Lock, Search, Link2, KeyRound, ShieldAlert,
  SlidersHorizontal, ArrowUpDown, CircleDot, MoreHorizontal, RotateCw, ArrowRight, Database, Users, LayoutDashboard,
  Radio, Luggage, Globe, Image, CalendarDays, Bell, Info, History, PauseCircle,
  Wallet, Puzzle, MapPin, ListChecks, Pencil, Tag, FileText, Route, Navigation, Clock, LocateFixed, Palette, Bot,
} from 'lucide-react'
import PluginIcon from '../../../components/shared/PluginIcon'
import { adminApi } from '../../../api/client'
import { useInstanceSettings } from '../../../components/Admin/useInstanceSettings'
import { bypassChip, bypassOffer, useRangeBypass, type RangeWarning, type TrekRangeBypass } from '../../../components/Admin/useRangeBypass'
import { usePluginStore } from '../../../store/pluginStore'
import { useTranslation } from '../../../i18n'
import { useToast } from '../../../components/shared/Toast'
import MToggle from '../../components/MToggle'
import MSheet from '../../components/MSheet'
import MSegmented from '../../components/MSegmented'
import MConfirmSheet from '../settings/MConfirmSheet'
import { MAdminButton, MAdminSheetFrame } from './MAdminUi'

/**
 * Admin → Plugins, mobile skin. A drop-in replacement for the desktop
 * AdminPluginsPanel: identical logic (segmented Installed/Discover switch,
 * search + type/status/sort filters, updates bar, installed rows with capability
 * chips, a registry list, an enriched detail sheet and the update re-consent
 * gate) with the mobile design system as the presentation layer. Every dialog is
 * an MSheet; every boolean is an MToggle.
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
   * "Instance settings" sheet action without a per-plugin fetch. */
  instanceSettingsCount?: number
  /** How many `scope:'instance'` actions the plugin declares — a plugin with actions
   * but no settings fields still needs the sheet action to run them. */
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
    permissions: string[]
    egress: string[]
    /** The plugin needs OPERATOR-supplied hosts — its egress list is not the whole story. */
    operatorEgress?: boolean
    settings: Array<{ key: string; label: string; inputType: string; scope: string; required: boolean }>
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

// Runtime health → dot colour on the icon tile (mobile status tokens).
const HEALTH: Record<string, string> = {
  active: 'bg-[color:var(--m-st-confirmed)]',
  starting: 'bg-[color:var(--m-st-info)] animate-pulse',
  error: 'bg-[color:var(--m-st-danger)]',
  inactive: 'bg-[color:var(--m-faint)]',
  disabled: 'bg-[color:var(--m-st-pending)]',
  incompatible: 'bg-[color:var(--m-st-pending)]',
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

// ── Chip / badge tone helpers (mobile status tokens) ────────────────────────
const CHIP_NEUTRAL = 'text-m-muted border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)]'
const CHIP_INFO = 'text-[color:var(--m-st-info)] border-[color:color-mix(in_srgb,var(--m-st-info)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--m-st-info)_10%,transparent)]'
const CHIP_PENDING = 'text-[color:var(--m-st-pending)] border-[color:color-mix(in_srgb,var(--m-st-pending)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--m-st-pending)_10%,transparent)]'
const PENDING_CARD = 'border-[color:color-mix(in_srgb,var(--m-st-pending)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--m-st-pending)_10%,transparent)]'
const ACT_PILL = 'inline-flex flex-none items-center justify-center gap-[5px] whitespace-nowrap rounded-full px-3 py-[7px] text-[0.6875rem] font-bold bg-m-act text-m-actfg disabled:opacity-50'

function ReviewedBadge({ t }: { t: T }) {
  return <ShieldCheck size={13} className="shrink-0 text-[color:var(--m-st-confirmed)]" aria-label={t('admin.plugins.reviewed')} />
}

/** Marks a manually-uploaded (sideloaded) plugin: no registry, unsigned, not reviewed. */
function SideloadedBadge({ t }: { t: T }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-[2px] text-[11px] font-medium ${CHIP_PENDING}`}
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
      <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-[2px] text-[11px] font-medium ${CHIP_NEUTRAL}`}
        title={t('admin.plugins.signedHint')}>
        <KeyRound size={11} /> {t('admin.plugins.signed')}
      </span>
    )
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-[2px] text-[11px] font-medium ${CHIP_PENDING}`}
      title={t('admin.plugins.unsignedHint')}>
      <ShieldAlert size={11} /> {t('admin.plugins.unsigned')}
    </span>
  )
}

/** Marks a dev-linked plugin: loaded from a local build dir + hot-reloaded (dev only). */
function DevLinkBadge({ t }: { t: T }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-[2px] text-[11px] font-medium ${CHIP_INFO}`}
      title={t('admin.plugins.devLinkHint')}>
      <Link2 size={11} /> {t('admin.plugins.devLinkBadge')}
    </span>
  )
}

function TypeBadge({ type, t }: { type: string; t: T }) {
  return (
    <span className="inline-flex items-center rounded-md bg-[color:var(--m-ic)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-m-muted">
      {KNOWN_TYPES.includes(type) ? t(`admin.plugins.type.${type}` as never) : type}
    </span>
  )
}

export default function MAdminPluginsPanel() {
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
  const [egressDraft, setEgressDraft] = useState('')
  const [egressSaving, setEgressSaving] = useState(false)
  const [egressError, setEgressError] = useState('')
  // The admin-owned scope:'instance' settings sheet — shared logic with the desktop shell.
  const settings = useInstanceSettings()
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
  // Mirrors onDragEnter: a leave that had no matching enter (a non-file drag) is ignored
  // instead of driving the depth counter negative.
  const onDragLeave = () => {
    if (dragDepth.current === 0) return
    if (--dragDepth.current === 0) setDragActive(false)
  }
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
    adminApi.pluginUpdate(p.id, version)
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
    else runUpdate(p, version)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const updatable = useMemo(() => plugins.filter(updateAvailable), [plugins, latest])

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

  // The plugin whose ⋯ action sheet is open (menu === `row:${id}`).
  const rowMenuPlugin = menu?.startsWith('row:') ? plugins.find(p => `row:${p.id}` === menu) ?? null : null

  return (
    <div className="relative space-y-3"
      onDragEnter={onDragEnter} onDragOver={e => { if (dragActive) e.preventDefault() }} onDragLeave={onDragLeave} onDrop={onDrop}>
      {/* Hidden input for the "Upload plugin" button (drag-drop uses the same handler). */}
      <input ref={uploadInputRef} type="file" accept=".zip,.tgz,.tar.gz" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) void uploadPlugin(f); e.target.value = '' }} />
      {/* Drag-to-install overlay */}
      {dragActive && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2.5 rounded-[18px] border-2 border-dashed border-m-act bg-[color:color-mix(in_srgb,var(--m-sheetop)_85%,transparent)] backdrop-blur-[2px] pointer-events-none">
          <UploadCloud size={34} className="text-m-ink" />
          <span className="text-sm font-semibold text-m-ink">{t('admin.plugins.dropToUpload')}</span>
        </div>
      )}

      {/* Header */}
      <div className="rounded-[18px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)] p-[14px]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-[0.9375rem] font-extrabold text-m-ink">
              <Puzzle size={16} strokeWidth={2.2} className="flex-none" />
              {t('admin.plugins.title')}
            </h2>
            <p className="mt-1 font-geist text-[0.625rem] leading-relaxed text-m-muted">{t('admin.plugins.subtitle')}</p>
          </div>
          <div className="flex flex-none items-center gap-1.5">
            {runtimeOn && ignoreTrekRange && (
              <span className="inline-flex flex-none items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--m-st-pending)_14%,transparent)] px-2.5 py-1 text-[10px] font-bold text-[color:var(--m-st-pending)]"
                title={t('admin.plugins.rangeBypass.pillHint')}>
                <AlertTriangle size={11} /> {t('admin.plugins.rangeBypass.pill')}
              </span>
            )}
            {runtimeOn && (
              <span className="inline-flex flex-none items-center gap-1.5 rounded-full bg-[color:color-mix(in_srgb,var(--m-st-confirmed)_14%,transparent)] px-2.5 py-1 text-[10px] font-bold text-[color:var(--m-st-confirmed)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--m-st-confirmed)]" /> {t('admin.plugins.runtimeOn')}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Runtime-disabled notice */}
      {!runtimeOn && !loading && !error && (
        <div className={`flex items-start gap-3 rounded-[18px] border p-4 ${PENDING_CARD}`}>
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[color:var(--m-st-pending)]" />
          <div>
            <p className="text-[0.8125rem] font-bold text-m-ink">{t('admin.plugins.disabledTitle')}</p>
            <p className="mt-0.5 font-geist text-[0.625rem] leading-relaxed text-m-muted">{t('admin.plugins.disabledBody')}</p>
          </div>
        </div>
      )}

      {/* Dev-link: register + hot-reload a plugin from a local build dir (dev only). */}
      {devLink && runtimeOn && !loading && !error && (
        <form onSubmit={(e) => { e.preventDefault(); void linkLocal() }}
          className={`flex flex-col gap-2.5 rounded-[18px] border p-3 ${CHIP_INFO}`}>
          <div className="flex items-center gap-2 text-[color:var(--m-st-info)]" title={t('admin.plugins.devLinkHint')}>
            <Link2 size={15} />
            <span className="text-xs font-bold">{t('admin.plugins.devLinkTitle')}</span>
          </div>
          <input value={linkPath} onChange={(e) => setLinkPath(e.target.value)} spellCheck={false}
            placeholder={t('admin.plugins.devLinkPathPlaceholder')}
            className="h-[42px] w-full rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)] px-3 text-[0.84375rem] text-m-ink outline-none placeholder:text-m-faint" />
          <MAdminButton onClick={() => void linkLocal()} disabled={!linkPath.trim() || busy === '__link'} className="self-start">
            <Link2 size={13} /> {t('admin.plugins.devLinkButton')}
          </MAdminButton>
        </form>
      )}

      {/* Toolbar */}
      {runtimeOn && !loading && !error && (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <MSegmented
                value={view}
                onChange={(v) => { if (v === 'discover') openDiscover(); else setView('installed') }}
                options={[
                  { value: 'installed', label: <TabLabel text={t('admin.plugins.installed')} count={plugins.length} active={view === 'installed'} /> },
                  { value: 'discover', label: <TabLabel text={t('admin.plugins.tabDiscover')} count={registry?.length ?? undefined} active={view === 'discover'} /> },
                ]}
              />
            </div>
            <ToolIcon label={t('admin.plugins.upload')} onClick={pickUpload}><UploadCloud size={15} /></ToolIcon>
            <ToolIcon label={t('admin.plugins.rescan')} onClick={rescan}><RefreshCw size={15} /></ToolIcon>
          </div>

          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-m-faint" />
            <input
              value={q} onChange={e => setQ(e.target.value)} type="search"
              placeholder={t('admin.plugins.searchPlaceholder')}
              className="h-[42px] w-full rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] pl-9 pr-3 text-[0.84375rem] text-m-ink outline-none placeholder:text-m-faint focus:border-[color:var(--m-faint)]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <FilterPill label={t('admin.plugins.filterType')} value={typeLabel(typeFilter, t)} active={typeFilter !== 'all'}
              icon={<SlidersHorizontal size={13} />} onClick={() => setMenu('type')} />
            {view === 'installed' && (
              <FilterPill label={t('admin.plugins.filterStatus')} value={statusLabel(statusFilter, t)} active={statusFilter !== 'all'}
                icon={<CircleDot size={13} />} onClick={() => setMenu('status')} />
            )}
            <FilterPill label={t('admin.plugins.sortBy')} value={sortLabel(sort, t)} active={sort !== 'name'}
              icon={<ArrowUpDown size={13} />} onClick={() => setMenu('sort')} />
          </div>
        </div>
      )}

      {/* Body */}
      {loading ? (
        <div className="py-14 text-center text-sm text-m-faint">{t('common.loading')}</div>
      ) : error ? (
        <div className="py-14 text-center text-sm text-[color:var(--m-st-danger)]">{t('admin.plugins.loadError')}</div>
      ) : !runtimeOn ? null : view === 'discover' ? (
        <RegistryList items={shownRegistry} busy={busy} t={t} installedIds={installedIds} ignoreTrekRange={ignoreTrekRange}
          onInstall={install} onOpenDetail={setDetailFor} filtered={anyFilter} />
      ) : plugins.length === 0 ? (
        <EmptyState t={t} onDiscover={openDiscover} />
      ) : (
        <div className="space-y-2">
          {updatable.length > 0 && statusFilter !== 'err' && (
            <div className={`flex items-center gap-2.5 rounded-[18px] border px-3.5 py-2.5 ${PENDING_CARD}`}>
              <ArrowUpCircle size={16} className="shrink-0 text-[color:var(--m-st-pending)]" />
              <span className="text-[0.6875rem] text-m-muted">{t('admin.plugins.updatesAvailable', { count: updatable.length })}</span>
              {/* p => runUpdate(p), NOT forEach(runUpdate): forEach's index would land in
                  runUpdate's `version` parameter and pin the update to a number. */}
              <button type="button" onClick={() => updatable.forEach(p => runUpdate(p))}
                className="ml-auto rounded-full bg-[color:var(--m-st-pending)] px-3 py-1.5 text-[0.6875rem] font-bold text-white">
                {t('admin.plugins.updateAll')}
              </button>
            </div>
          )}
          {shownInstalled.length === 0 ? (
            <div className="py-12 text-center">
              <Search size={26} className="mx-auto mb-3 text-m-faint" />
              <p className="text-sm text-m-faint">{t('admin.plugins.noMatchInstalled')}</p>
            </div>
          ) : shownInstalled.map(p => (
            <InstalledRow key={p.id} p={p} t={t} busy={busy}
              hasUpdate={updateAvailable(p)} latestVer={latest[p.id]}
              newerIncompatible={newerIncompatible(p)}
              blocked={blockIsCurrent(p, latest[p.id])}
              onToggle={() => toggle(p)}
              onUpdate={() => runUpdate(p)}
              onResume={() => void resumeUpdates(p)}
              onReviewBlock={() => setSignatureBlock({
                subject: { id: p.id, name: p.name, keyFingerprint: p.keyFingerprint ?? null },
                code: p.updateBlock!.code, detail: p.updateBlock!.detail,
              })}
              onEgress={() => openEgress(p.id)}
              onMenu={() => setMenu(`row:${p.id}`)} />
          ))}
        </div>
      )}

      <SecurityInfo t={t} />

      {/* Registry detail sheet */}
      {detailFor && (
        <PluginDetailSheet item={detailFor} t={t} locale={locale} busy={busy} ignoreTrekRange={ignoreTrekRange}
          installed={installedIds.has(detailFor.id)} onInstall={install} onClose={() => setDetailFor(null)} />
      )}

      {/* TREK_PLUGINS_IGNORE_TREK_RANGE: confirm before a registry install the server would
          otherwise refuse (onConfirm set), or a plain notice after a path that could not
          ask first — sideload, dev-link, update, dependency download. */}
      {bypass.copy && (
        <MConfirmSheet open onClose={bypass.dismiss} onConfirm={bypass.copy.confirm ? bypass.confirm : undefined}
          title={bypass.copy.title} message={bypass.copy.body}
          confirmLabel={t('admin.plugins.installAnyway')} cancelLabel={bypass.copy.confirm ? t('common.cancel') : t('common.ok')} danger />
      )}

      {/* Row ⋯ action sheet */}
      {rowMenuPlugin && (
        <RowActionsSheet p={rowMenuPlugin} t={t} onClose={() => setMenu(null)}
          onRestart={() => restart(rowMenuPlugin.id)}
          onErrors={() => openErrors(rowMenuPlugin.id)}
          onEgress={() => openEgress(rowMenuPlugin.id)}
          onSettings={() => openInstanceSettings(rowMenuPlugin)}
          onChangeVersion={() => openVersionPicker(rowMenuPlugin)}
          onUninstall={() => { setMenu(null); setConfirmUninstall(rowMenuPlugin) }} />
      )}

      {/* Version picker sheet */}
      {versionPicker && (
        <VersionPickerSheet plugin={versionPicker.plugin} versions={versionPicker.versions} failed={versionPicker.failed}
          busy={busy} t={t} locale={locale} onPick={pickVersion} onClose={() => setVersionPicker(null)} />
      )}

      {/* Downgrade confirm */}
      <MConfirmSheet
        open={!!confirmDowngrade}
        onClose={() => setConfirmDowngrade(null)}
        onConfirm={() => { const d = confirmDowngrade!; setConfirmDowngrade(null); runUpdate(d.plugin, d.version) }}
        title={t('admin.plugins.downgradeTitle')}
        message={t('admin.plugins.downgradeBody', { from: confirmDowngrade?.plugin.version ?? '', to: confirmDowngrade?.version ?? '' })}
        confirmLabel={t('admin.plugins.downgradeConfirm')}
        cancelLabel={t('common.cancel')}
        danger
      />

      {/* Filter picker sheets */}
      <PickerSheet
        open={menu === 'type'} onClose={() => setMenu(null)} title={t('admin.plugins.filterType')} value={typeFilter}
        options={[
          ['all', t('admin.plugins.allTypes')], ['widget', t('admin.plugins.type.widget')],
          ['integration', t('admin.plugins.type.integration')], ['page', t('admin.plugins.type.page')],
          ['trip-page', t('admin.plugins.type.trip-page')],
        ]}
        onPick={v => setTypeFilter(v as TypeFilter)} />
      <PickerSheet
        open={menu === 'status'} onClose={() => setMenu(null)} title={t('admin.plugins.filterStatus')} value={statusFilter}
        options={[
          ['all', t('admin.plugins.allStatuses')], ['on', t('admin.plugins.status.active')], ['off', t('admin.plugins.stateOff')],
          ['update', t('admin.plugins.filterUpdate')], ['err', t('admin.plugins.status.error')],
        ]}
        onPick={v => setStatusFilter(v as StatusFilter)} />
      <PickerSheet
        open={menu === 'sort'} onClose={() => setMenu(null)} title={t('admin.plugins.sortBy')} value={sort}
        options={view === 'discover'
          ? [['name', t('admin.plugins.sortName')], ['recent', t('admin.plugins.sortRecent')], ['downloads', t('admin.plugins.sortDownloads')]]
          : [['name', t('admin.plugins.sortName')], ['recent', t('admin.plugins.sortRecent')], ['updates', t('admin.plugins.sortUpdates')]]}
        onPick={v => setSort(v as SortKey)} />

      {/* Error-log sheet */}
      {errorsFor && (
        <MSheet open onClose={() => setErrorsFor(null)} variant="bottom" material="opaque" ariaLabel={t('admin.plugins.errorLog')}>
          <MAdminSheetFrame
            title={<span className="flex items-center gap-2"><Bug size={15} /> {errorsFor.id} — {t('admin.plugins.errorLog')}</span>}
            onClose={() => setErrorsFor(null)}
          >
            <div className="font-mono text-[0.6875rem]">
              {errorsFor.rows.length === 0 ? <p className="py-4 text-center text-m-faint">{t('admin.plugins.noErrors')}</p> :
                errorsFor.rows.map((r, i) => (
                  <div key={i} className="flex gap-2 border-b border-[color:var(--m-rowbr)] py-1.5 last:border-0">
                    <span className={`shrink-0 font-semibold ${r.level === 'error' ? 'text-[color:var(--m-st-danger)]' : 'text-[color:var(--m-st-pending)]'}`}>{r.level}</span>
                    <span className="shrink-0 text-m-faint">{r.ts}</span>
                    <span className="break-all text-m-muted">{r.message}</span>
                  </div>
                ))}
            </div>
          </MAdminSheetFrame>
        </MSheet>
      )}

      {/* Operator-supplied egress hosts */}
      {egressFor && (
        <MSheet open onClose={() => setEgressFor(null)} variant="bottom" material="opaque" ariaLabel={t('admin.plugins.allowedHosts')}>
          <MAdminSheetFrame
            title={<span className="flex items-center gap-2"><Globe size={15} /> {egressFor.id} — {t('admin.plugins.allowedHosts')}</span>}
            onClose={() => setEgressFor(null)}
          >
            {!egressFor.supported ? (
              <p className="text-sm text-m-faint">{t('admin.plugins.allowedHosts.unsupported')}</p>
            ) : (
              <div className="space-y-3">
                <p className="font-geist text-[0.625rem] text-m-faint">{t('admin.plugins.allowedHosts.hint')}</p>
                {egressFor.hosts.length === 0 && (
                  <p className="text-sm italic text-m-faint">{t('admin.plugins.allowedHosts.none')}</p>
                )}
                {egressFor.hosts.map(h => (
                  <div key={h} className="flex items-center justify-between gap-2 rounded-xl border border-[color:var(--m-rowbr)] px-3 py-2">
                    <span className="break-all font-mono text-sm text-m-ink">{h}</span>
                    <button type="button"
                      disabled={egressSaving}
                      onClick={() => saveEgress(egressFor.hosts.filter(x => x !== h))}
                      className="text-m-faint disabled:opacity-50"
                      aria-label={t('common.delete')}
                    ><Trash2 size={14} /></button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input
                    value={egressDraft}
                    onChange={e => setEgressDraft(e.target.value)}
                    placeholder="gotify.example.com"
                    className="h-[42px] min-w-0 flex-1 rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 text-[0.84375rem] text-m-ink outline-none placeholder:text-m-faint focus:border-[color:var(--m-faint)]"
                  />
                  <MAdminButton
                    disabled={egressSaving || !egressDraft.trim()}
                    onClick={() => saveEgress([...egressFor.hosts, egressDraft.trim()])}
                    className="h-[42px]"
                  >{t('common.add')}</MAdminButton>
                </div>
                {egressError && <p className="text-[0.6875rem] text-[color:var(--m-st-danger)]">{egressError}</p>}
                <p className="font-geist text-[0.625rem] text-m-faint">{t('admin.plugins.allowedHosts.restartNote')}</p>
              </div>
            )}
          </MAdminSheetFrame>
        </MSheet>
      )}

      {/* Instance-wide settings (the admin-owned scope:'instance' fields) */}
      {settings.form && (
        <MSheet open onClose={settings.close} variant="bottom" material="opaque" ariaLabel={t('admin.plugins.instanceSettings')}>
          <MAdminSheetFrame
            title={<span className="flex items-center gap-2"><SlidersHorizontal size={15} /> {settings.form.id} — {t('admin.plugins.instanceSettings')}</span>}
            onClose={settings.close}
          >
            <div className="space-y-4">
              {settings.form.fields.map(f => (
                <label key={f.key} className="block">
                  <span className="mb-1 block text-sm font-medium text-m-ink">
                    {f.label || f.key}{f.required && <span className="text-[color:var(--m-st-danger)]"> *</span>}
                  </span>
                  {f.input_type === 'checkbox' ? (
                    <MToggle
                      checked={settings.form.values[f.key] === true}
                      onChange={on => settings.setValue(f.key, on)}
                      ariaLabel={f.label || f.key}
                    />
                  ) : f.input_type === 'select' && f.options ? (
                    <select
                      value={String(settings.form.values[f.key] ?? '')}
                      onChange={e => settings.setValue(f.key, e.target.value)}
                      className="h-[42px] w-full rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 text-[0.84375rem] text-m-ink outline-none focus:border-[color:var(--m-faint)]"
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
                      className="h-[42px] w-full rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 text-[0.84375rem] text-m-ink outline-none placeholder:text-m-faint focus:border-[color:var(--m-faint)]"
                    />
                  )}
                  {f.hint && <span className="mt-1 block font-geist text-[0.625rem] text-m-faint">{f.hint}</span>}
                </label>
              ))}
              {(() => {
                const form = settings.form
                if (!form || form.actions.length === 0) return null
                return (
                  <div className="border-t border-[color:var(--m-rowbr)] pt-4">
                    <span className="mb-2 block font-geist text-[0.625rem] font-bold uppercase tracking-wide text-m-faint">
                      {t('admin.plugins.actions')}
                    </span>
                    {!form.active && (
                      <p className="mb-2 font-geist text-[0.625rem] text-m-faint">{t('admin.plugins.actions.inactive')}</p>
                    )}
                    <div className="flex flex-col gap-2">
                      {form.actions.map(a => {
                        const res = settings.actionResult[a.key]
                        return (
                          <div key={a.key} className="flex flex-wrap items-center gap-2">
                            <MAdminButton
                              variant={a.danger ? 'danger' : 'ghost'}
                              busy={settings.runningAction === a.key}
                              disabled={!form.active || settings.runningAction !== null || settings.saving}
                              onClick={() => settings.runAction(a)}
                            >
                              {a.label}
                            </MAdminButton>
                            {a.hint && <span className="font-geist text-[0.625rem] text-m-faint">{a.hint}</span>}
                            {res && (
                              <span aria-live="polite" className={`text-[0.625rem] font-bold ${res.ok ? 'text-[color:var(--m-st-confirmed)]' : 'text-[color:var(--m-st-danger)]'}`}>
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
              {settings.error && <p className="text-[0.6875rem] text-[color:var(--m-st-danger)]">{settings.error}</p>}
              <MAdminButton disabled={settings.saving || settings.runningAction !== null} onClick={() => void settings.save()} className="h-[42px] w-full">
                {t('common.save')}
              </MAdminButton>
            </div>
          </MAdminSheetFrame>
        </MSheet>
      )}

      {/* Uninstall confirm */}
      <MConfirmSheet
        open={!!confirmUninstall}
        onClose={() => setConfirmUninstall(null)}
        onConfirm={async () => {
          const p = confirmUninstall!; setConfirmUninstall(null)
          await act(p.id, () => adminApi.pluginUninstall(p.id, true), t('admin.plugins.uninstalled'))
        }}
        title={t('admin.plugins.uninstallTitle')}
        message={t('admin.plugins.uninstallBody')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
      />

      {/* Instance action confirm */}
      <MConfirmSheet
        open={settings.pendingAction !== null}
        onClose={settings.cancelPendingAction}
        onConfirm={settings.confirmPendingAction}
        title={settings.pendingAction?.label ?? ''}
        message={t('admin.plugins.actions.confirm')}
        confirmLabel={settings.pendingAction?.label}
        cancelLabel={t('common.cancel')}
        danger
      />

      {signatureBlock && (
        <SignatureBlockSheet
          data={signatureBlock} entry={regById[signatureBlock.subject.id]} busy={retrusting} t={t}
          onRetrust={(version, publicKey) => confirmRetrust(signatureBlock.subject.id, version, publicKey)}
          onClose={() => setSignatureBlock(null)}
        />
      )}

      {consentQueue[0] && (
        <UpdateConsentSheet
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
        <DependencyResolveSheet
          data={depResolve} t={t} busy={busy === depResolve.plugin.id} installedIds={installedIds}
          onDownload={(depId, constraint) => resolveDependency(depResolve.plugin, depId, constraint)}
          onClose={() => setDepResolve(null)}
        />
      )}
    </div>
  )
}

// ── Toolbar bits ────────────────────────────────────────────────────────────

function TabLabel({ text, count, active }: { text: string; count?: number; active: boolean }) {
  return (
    <span className="inline-flex items-center gap-[6px]">
      {text}
      {count != null && (
        <span className={`inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1 text-[0.625rem] font-bold tabular-nums ${
          active ? 'bg-[color:color-mix(in_srgb,var(--m-actfg)_20%,transparent)] text-m-actfg' : 'bg-[color:var(--m-ic)] text-m-muted'}`}>{count}</span>
      )}
    </span>
  )
}

function ToolIcon({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label}
      className="grid h-[42px] w-[42px] flex-none place-items-center rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] text-m-muted">
      {children}
    </button>
  )
}

function FilterPill({ label, value, active, icon, onClick }: { label: string; value: string; active: boolean; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title={`${label}: ${value}`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-[7px] text-[0.71875rem] font-semibold ${
        active ? 'border-[color:var(--m-faint)] bg-[color:var(--m-ic)] text-m-ink' : 'border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] text-m-muted'}`}>
      {icon}
      <span>{value}</span>
      <ChevronDown size={12} className="text-m-faint" />
    </button>
  )
}

function typeLabel(f: TypeFilter, t: T): string {
  return f === 'all' ? t('admin.plugins.allTypes') : t(`admin.plugins.type.${f}` as never)
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

function PickerSheet({ open, onClose, title, options, value, onPick }: {
  open: boolean; onClose: () => void; title: string
  options: Array<[string, string]>; value: string; onPick: (v: string) => void
}) {
  return (
    <MSheet open={open} onClose={onClose} variant="bottom" material="opaque" ariaLabel={title}>
      <MAdminSheetFrame title={title} onClose={onClose}>
        <div className="space-y-1">
          {options.map(([v, lbl]) => (
            <button key={v} type="button" onClick={() => { onPick(v); onClose() }}
              className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-3 text-left text-[0.8125rem] ${
                value === v ? 'bg-[color:var(--m-ic)] font-bold text-m-ink' : 'font-medium text-m-muted'}`}>
              <span className="min-w-0 flex-1 truncate">{lbl}</span>
              <Check size={16} className={`text-m-ink ${value === v ? 'opacity-100' : 'opacity-0'}`} />
            </button>
          ))}
        </div>
      </MAdminSheetFrame>
    </MSheet>
  )
}

// ── Installed row ──────────────────────────────────────────────────────────

function InstalledRow({ p, t, busy, hasUpdate, latestVer, newerIncompatible, blocked, onToggle, onUpdate, onResume, onReviewBlock, onEgress, onMenu }: {
  p: PluginRow; t: T; busy: string | null
  hasUpdate: boolean; latestVer?: string; newerIncompatible: { version: string; range: string } | null; blocked: boolean
  onToggle: () => void; onUpdate: () => void; onResume: () => void; onReviewBlock: () => void
  onEgress: () => void; onMenu: () => void
}) {
  const caps = deriveCaps(parseJson<string[]>(p.permissions, []), parseJson<{ widget?: { slot?: string } }>(p.capabilities, {}), t)
  const deps = deriveDeps(p, t)

  return (
    <div className="rounded-[18px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)] p-[14px]">
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">
          <div className="grid h-[46px] w-[46px] place-items-center rounded-[13px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)]">
            <PluginIcon name={p.icon} size={22} className="text-m-muted" />
          </div>
          <span className={`absolute -bottom-0.5 -right-0.5 h-[13px] w-[13px] rounded-full ring-[2.5px] ring-[color:var(--m-sheetop)] ${HEALTH[p.status] || HEALTH.inactive}`}
            title={t(`admin.plugins.status.${p.status}` as never)} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.90625rem] font-bold tracking-[-.006em] text-m-ink">{p.name}</span>
            {p.version && <span className="text-[11.5px] font-medium tabular-nums text-m-faint">v{p.version}</span>}
            {p.reviewed_at && <ReviewedBadge t={t} />}
            {p.source_repo === 'local:upload' && <SideloadedBadge t={t} />}
            {p.source_repo === 'local:link' && <DevLinkBadge t={t} />}
            {/* Registry plugins only — a sideloaded/dev-linked plugin already says something
                strictly stronger, and stacking "Unsigned" on top of it just dilutes the amber. */}
            {isRegistrySourced(p.source_repo) && <TrustBadge signed={!!p.signed} t={t} />}
          </div>
          {p.description && <p className="mt-0.5 truncate text-[12.5px] text-m-muted">{p.description}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <MToggle checked={p.enabled === 1} ariaLabel={t('admin.plugins.enabledToggle')} onChange={onToggle} />
          <button type="button" onClick={onMenu} data-testid={`plugin-row-menu-btn-${p.id}`}
            className="grid h-[34px] w-[34px] place-items-center rounded-lg text-m-faint">
            <MoreHorizontal size={17} />
          </button>
        </div>
      </div>

      {/* A refused update leaves a WORKING plugin pinned at its old version — so this is
          its own row state, not an error state, and it persists until it is resolved
          rather than dying with the toast that first reported it. */}
      {blocked && p.updateBlock && (
        <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-[color:var(--m-st-pending)]">
          <ShieldAlert size={13} className="shrink-0" />
          <span className="truncate">{t('admin.plugins.updateBlocked', { reason: p.updateBlock.detail ?? p.updateBlock.code })}</span>
          <button type="button" onClick={onReviewBlock}
            className="shrink-0 font-semibold underline underline-offset-2">
            {t('admin.plugins.reviewBlock')}
          </button>
        </div>
      )}

      {/* A newer version this TREK can't run — informational, never a button: the fix
          is a TREK upgrade, so the row must not nag or offer a doomed install. */}
      {newerIncompatible && (
        <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-m-faint">
          <Info size={13} className="shrink-0" />
          <span className="truncate">{t('admin.plugins.newerNeedsTrek', { version: newerIncompatible.version, range: newerIncompatible.range })}</span>
        </div>
      )}

      {/* Held: the admin deliberately installed a non-latest version, so updates are
          paused rather than nagged — resuming is one click, right where the pause shows. */}
      {p.updateHold && (
        <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-m-faint">
          <PauseCircle size={13} className="shrink-0" />
          <span className="truncate">{t('admin.plugins.updatesHeld', { version: p.version ?? '' })}</span>
          <button type="button" onClick={onResume} disabled={busy === p.id}
            className="shrink-0 font-semibold underline underline-offset-2 disabled:opacity-50">
            {t('admin.plugins.resumeUpdates')}
          </button>
        </div>
      )}

      {p.status === 'error' && p.last_error ? (
        <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-[color:var(--m-st-danger)]">
          <AlertTriangle size={13} className="shrink-0" /><span className="truncate">{p.last_error}</span>
        </div>
      ) : (caps.length > 0 || p.operatorEgress) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {caps.map((c, i) => (
            <span key={i} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-[3px] text-[11px] font-medium ${c.net ? CHIP_INFO : CHIP_NEUTRAL}`}>
              <c.icon size={12} className={c.net ? 'text-[color:var(--m-st-info)]' : 'text-m-faint'} />{c.label}
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
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-[3px] text-[11px] font-medium ${p.egressHostCount > 0 ? CHIP_INFO : CHIP_PENDING}`}
            >
              <Globe size={12} className={p.egressHostCount > 0 ? 'text-[color:var(--m-st-info)]' : 'text-[color:var(--m-st-pending)]'} />
              {p.egressHostCount > 0
                ? t('admin.plugins.allowedHosts.count').replace('{n}', String(p.egressHostCount))
                : t('admin.plugins.allowedHosts.add')}
            </button>
          )}
        </div>
      )}

      {deps.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {deps.map((d, i) => (
            <span key={i} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-[3px] text-[11px] font-medium ${d.blocked || d.warn ? CHIP_PENDING : CHIP_NEUTRAL}`}>
              <d.icon size={12} className={d.blocked || d.warn ? 'text-[color:var(--m-st-pending)]' : 'text-m-faint'} />{d.label}
            </span>
          ))}
        </div>
      )}

      {hasUpdate && (
        <div className="mt-2.5 border-t border-[color:var(--m-rowbr)] pt-2.5">
          <button type="button" onClick={onUpdate} disabled={busy === p.id} title={t('admin.plugins.updateTo', { version: latestVer })}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11.5px] font-bold disabled:opacity-50 ${CHIP_PENDING}`}>
            <ArrowUpCircle size={13} /> {t('admin.plugins.updateTo', { version: latestVer })}
          </button>
        </div>
      )}
    </div>
  )
}

// Row ⋯ action sheet — the desktop portal menu re-expressed as a bottom sheet.
function RowActionsSheet({ p, t, onClose, onRestart, onErrors, onEgress, onSettings, onChangeVersion, onUninstall }: {
  p: PluginRow; t: T; onClose: () => void
  onRestart: () => void; onErrors: () => void; onEgress: () => void; onSettings: () => void; onChangeVersion: () => void; onUninstall: () => void
}) {
  const linkable = p.source_repo && p.source_repo !== 'local:upload' && p.source_repo !== 'local:link'
  const rowClass = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-3 text-left text-[0.8125rem] font-semibold text-m-ink'
  return (
    <MSheet open onClose={onClose} variant="bottom" material="opaque" ariaLabel={p.name}>
      <MAdminSheetFrame title={p.name} onClose={onClose}>
        <div className="space-y-1">
          {p.enabled === 1 && (
            <button type="button" className={rowClass} onClick={onRestart}><RotateCw size={16} /> {t('admin.plugins.restart')}</button>
          )}
          {/* A plugin gets the action if it declares scope:'instance' fields OR actions —
              an action-only plugin still needs the sheet to run them. */}
          {((p.instanceSettingsCount ?? 0) > 0 || (p.instanceActionsCount ?? 0) > 0) && (
            <button type="button" className={rowClass} onClick={onSettings}><SlidersHorizontal size={16} /> {t('admin.plugins.instanceSettings')}</button>
          )}
          <button type="button" className={rowClass} onClick={onErrors}><Bug size={16} /> {t('admin.plugins.viewErrors')}</button>
          {/* Only a plugin that DECLARED operatorEgress gets the action — an admin must
              never be invited to widen egress for a plugin that didn't ask for it
              (same rule the row's egress chip follows). */}
          {p.operatorEgress && (
            <button type="button" className={rowClass} onClick={onEgress}><Globe size={16} /> {t('admin.plugins.allowedHosts')}</button>
          )}
          {/* Registry plugins only — a sideload/dev-link has no registry versions to pick from. */}
          {isRegistrySourced(p.source_repo) && (
            <button type="button" className={rowClass} onClick={onChangeVersion}><History size={16} /> {t('admin.plugins.changeVersion')}</button>
          )}
          {linkable && (
            <>
              <a href={`https://github.com/${p.source_repo}`} target="_blank" rel="noreferrer" onClick={onClose} className={rowClass}>
                <Github size={16} /> {t('admin.plugins.sourceRepo')}
              </a>
              <a href={`https://github.com/${p.source_repo}/issues`} target="_blank" rel="noreferrer" onClick={onClose} className={rowClass}>
                <CircleDot size={16} /> {t('admin.plugins.reportIssue')}
              </a>
            </>
          )}
          <div className="my-1 border-t border-[color:var(--m-rowbr)]" />
          <button type="button" className="flex w-full items-center gap-2.5 rounded-xl px-3 py-3 text-left text-[0.8125rem] font-semibold text-[color:var(--m-st-danger)]" onClick={onUninstall}>
            <Trash2 size={16} /> {t('common.delete')}
          </button>
        </div>
      </MAdminSheetFrame>
    </MSheet>
  )
}

/**
 * "Change version…" for an INSTALLED plugin. Rows render the server's per-version compat
 * verdict: the installed version is marked, a compatible one gets a Switch action (the
 * caller routes a DOWNGRADE through the data-risk confirm), an incompatible one is
 * explained and never offered.
 */
function VersionPickerSheet({ plugin, versions, failed, busy, t, locale, onPick, onClose }: {
  plugin: PluginRow; versions: VersionInfo[] | null; failed: boolean; busy: string | null
  t: T; locale: string; onPick: (version: string) => void; onClose: () => void
}) {
  return (
    <MSheet open onClose={onClose} variant="bottom" material="opaque" ariaLabel={t('admin.plugins.versionPickerTitle', { name: plugin.name })}>
      <MAdminSheetFrame title={t('admin.plugins.versionPickerTitle', { name: plugin.name })} onClose={onClose}>
        <div className="space-y-0.5">
          {failed && <p className="px-2.5 py-2 text-xs text-[color:var(--m-st-danger)]">{t('admin.plugins.detailError')}</p>}
          {!failed && !versions && <p className="px-2.5 py-2 text-xs text-m-faint">{t('common.loading')}</p>}
          {versions?.length === 0 && <p className="px-2.5 py-2 text-xs text-m-faint">{t('admin.plugins.noVersions')}</p>}
          {versions?.map(v => {
            const current = v.version === plugin.version
            return (
              <div key={v.version} data-testid={`version-row-${v.version}`}
                className="flex items-center gap-2.5 rounded-xl px-2.5 py-2.5">
                <span className={`text-[13px] font-semibold tabular-nums ${v.compatible ? 'text-m-ink' : 'text-m-faint'}`}>v{v.version}</span>
                {v.publishedAt && <span className="text-[11.5px] text-m-faint">{new Date(v.publishedAt).toLocaleDateString(locale)}</span>}
                {v.signed && <ShieldCheck size={13} className="shrink-0 text-[color:var(--m-st-confirmed)]" />}
                <span className="ml-auto" />
                {current ? (
                  <span className="text-[11.5px] font-medium text-m-faint">{t('admin.plugins.installed')}</span>
                ) : v.compatible ? (
                  <button type="button" onClick={() => onPick(v.version)} disabled={busy === plugin.id}
                    className="rounded-full border border-[color:var(--m-rowbr)] px-2.5 py-1 text-[11.5px] font-bold text-m-muted disabled:opacity-50">
                    {t('admin.plugins.versionSwitch', { version: v.version })}
                  </button>
                ) : (
                  <span className="text-[11.5px] text-m-faint">{t('admin.plugins.versionNeedsTrek', { range: v.trek ?? '' })}</span>
                )}
              </div>
            )
          })}
        </div>
      </MAdminSheetFrame>
    </MSheet>
  )
}

// ── Registry (Discover) ────────────────────────────────────────────────────

function EmptyState({ t, onDiscover }: { t: T; onDiscover: () => void }) {
  return (
    <div className="py-16 text-center">
      <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-[color:var(--m-ic)]">
        <PackageOpen size={26} className="text-m-faint" />
      </div>
      <p className="text-sm font-medium text-m-muted">{t('admin.plugins.empty')}</p>
      <button type="button" onClick={onDiscover} className={`mt-4 ${ACT_PILL}`}>
        <Download size={14} /> {t('admin.plugins.tabDiscover')}
      </button>
    </div>
  )
}

function Screenshot({ url, className, iconSize = 28 }: { url: string | null; className: string; iconSize?: number }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className={`overflow-hidden bg-[color:var(--m-ic)] ${className}`}>
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <div className="grid h-full w-full place-items-center">
          <Blocks size={iconSize} className="text-m-faint" />
        </div>
      )}
    </div>
  )
}

function RegistryList({ items, onInstall, onOpenDetail, busy, t, installedIds, filtered, ignoreTrekRange }: {
  items: RegistryItem[] | null
  onInstall: (id: string, version?: string, warn?: RangeWarning) => void
  onOpenDetail: (item: RegistryItem) => void
  busy: string | null
  t: T
  installedIds: Set<string>
  filtered: boolean
  ignoreTrekRange: boolean
}) {
  if (!items) return <div className="py-14 text-center text-sm text-m-faint">{t('common.loading')}</div>
  if (items.length === 0) return (
    <div className="py-14 text-center">
      <Search size={26} className="mx-auto mb-3 text-m-faint" />
      <p className="text-sm text-m-faint">{filtered ? t('admin.plugins.noMatchRegistry') : t('admin.plugins.registryEmpty')}</p>
    </div>
  )
  return (
    <div className="space-y-3">
      {items.map(item => {
        const installed = installedIds.has(item.id)
        const offer = installOffer(item, t, ignoreTrekRange)
        return (
          <div key={item.id} role="button" tabIndex={0} onClick={() => onOpenDetail(item)}
            // Same press-scale opt-out as the desktop Discover card (#2158).
            data-no-press
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenDetail(item) } }}
            className="overflow-hidden rounded-[18px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)]">
            <div className="relative">
              <Screenshot url={item.screenshotUrl} className="aspect-[16/10]" iconSize={24} />
              <div className="absolute inset-0 bg-gradient-to-t from-black/45 to-transparent" />
              {item.reviewedAt && (
                <span className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-black/40 px-2 py-1 text-[10.5px] font-semibold text-white backdrop-blur-sm">
                  <ShieldCheck size={12} /> {t('admin.plugins.reviewed')}
                </span>
              )}
              <div className="absolute -bottom-4 left-3 z-[1] grid h-11 w-11 place-items-center rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)] shadow-[0_5px_12px_-8px_rgba(0,0,0,.4)]">
                <PluginIcon name={item.icon} size={22} className="text-m-muted" />
              </div>
            </div>
            <div className="flex flex-col px-3.5 pb-3.5 pt-6">
              <span className="truncate text-sm font-bold tracking-[-.006em] text-m-ink">{item.name}</span>
              <span className="mt-0.5 text-[11.5px] text-m-faint">{item.author}</span>
              <p className="mt-2 line-clamp-2 text-xs text-m-muted">{item.description}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <TypeBadge type={item.type} t={t} />
                {/* Everything in Discover is registry-sourced, so the badge always applies. */}
                <TrustBadge signed={!!item.signed} t={t} />
                {item.latest && <span className="text-[10.5px] tabular-nums text-m-faint">v{item.latest}</span>}
                {typeof item.downloadCount === 'number' && item.downloadCount > 0 && (
                  <span className="inline-flex items-center gap-1 text-[10.5px] tabular-nums text-m-faint" title={t('admin.plugins.downloads')}>
                    <Download size={11} /> {formatCompactCount(item.downloadCount)}
                  </span>
                )}
                <button type="button" onClick={e => { e.stopPropagation(); onInstall(item.id, offer.version, offer.warn) }}
                  disabled={busy === item.id || installed || offer.blocked}
                  title={installed ? undefined : offer.title}
                  className={`ml-auto ${ACT_PILL}`}>
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
    : <code className="rounded bg-[color:var(--m-ic)] px-1.5 py-0.5 font-mono text-[11px]">{perm}</code>
}

function PluginDetailSheet({ item, installed, busy, onInstall, onClose, t, locale, ignoreTrekRange }: {
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
  const caps = manifest ? deriveCaps(manifest.permissions, manifest.capabilities ?? {}, t) : []
  const repoUrl = `https://github.com/${item.repo}`
  const homepage = item.homepage && /^https?:\/\//i.test(item.homepage) && item.homepage !== repoUrl ? item.homepage : null
  const sizeKb = detail?.size ? Math.max(1, Math.round(detail.size / 1024)) : null
  // The detail fetch carries the same compat verdict as the browse list; prefer it once
  // it lands (it is keyed to the same entry) and fall back to the grid item until then.
  const offer = installOffer(detail ?? item, t, ignoreTrekRange)
  const linkClass = 'inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-1.5 text-xs font-medium text-m-muted'
  const sectionH = 'text-[11px] font-semibold uppercase tracking-wider text-m-muted'

  return (
    <MSheet open onClose={onClose} variant="card" material="opaque" ariaLabel={item.name}>
      <div className="relative flex-none">
        <Screenshot url={item.screenshotUrl} className="aspect-[16/9] w-full" iconSize={36} />
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-lg bg-black/40 text-white"><X size={16} /></button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative z-[1] -mt-7 flex items-start gap-3 px-4">
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-[15px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)] shadow-[0_5px_12px_-8px_rgba(0,0,0,.4)]">
            <PluginIcon name={manifest?.icon ?? null} size={28} className="text-m-muted" />
          </div>
          <div className="min-w-0 flex-1 pt-8">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-bold tracking-tight text-m-ink">{item.name}</h3>
              {item.reviewedAt && <ReviewedBadge t={t} />}
            </div>
            <p className="mt-0.5 text-[12.5px] text-m-faint">{item.author}{item.latest ? ` · v${item.latest}` : ''}</p>
          </div>
          <button type="button" onClick={() => onInstall(item.id, offer.version, offer.warn)}
            disabled={busy === item.id || installed || offer.blocked}
            title={installed ? undefined : offer.title}
            className={`${ACT_PILL} self-end`}>
            {installed ? t('admin.plugins.installed') : offer.label}
          </button>
        </div>

        <div className="px-4 pb-5 pt-4">
          <p className="text-[13.5px] leading-relaxed text-m-muted">{item.description}</p>
          {failed && <p className="mt-3 text-xs text-[color:var(--m-st-danger)]">{t('admin.plugins.detailError')}</p>}
          {/* The reason the button is blocked (or offering an older version) — a tooltip
              alone would leave a touch user with a dead button and no explanation. */}
          {offer.title && !installed && (
            <p className={`mt-3 flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-xs ${CHIP_PENDING}`}>
              <AlertTriangle size={13} className="mt-[1px] shrink-0" /> {offer.title}
            </p>
          )}

          {manifest && (
            <div className="mt-5">
              <h4 className={sectionH}>{t('admin.plugins.accessTitle')}</h4>
              {caps.filter(c => !c.net).length === 0 && !manifest.permissions.includes('db:own') ? (
                <p className="mt-2 text-xs text-m-faint">{t('admin.plugins.noAccess')}</p>
              ) : (
                <div className="mt-2 space-y-1.5">
                  {caps.filter(c => !c.net).map((c, i) => (
                    <div key={i} className="flex items-start gap-2.5 py-0.5 text-[13px] text-m-muted">
                      <c.icon size={15} className="mt-0.5 shrink-0 text-[color:var(--m-st-info)]" /><span>{c.label}</span>
                    </div>
                  ))}
                  {manifest.permissions.includes('db:own') && (
                    <div className="flex items-start gap-2.5 py-0.5 text-[13px] text-m-muted">
                      <Database size={15} className="mt-0.5 shrink-0 text-[color:var(--m-st-info)]" /><span>{t('admin.plugins.perm.db:own')}</span>
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

          {manifest && (manifest.egress.length > 0 || manifest.operatorEgress) && (
            <div className="mt-5">
              <h4 className={sectionH}>{t('admin.plugins.connectsTitle')}</h4>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {manifest.egress.map(h => (
                  <code key={h} className="rounded-md bg-[color:color-mix(in_srgb,var(--m-st-info)_10%,transparent)] px-2 py-1 font-mono text-[12px] text-[color:var(--m-st-info)]">{h}</code>
                ))}
                {/* The hosts above are NOT the whole story for this plugin: it talks to a
                    service only the operator can name, so its reach is whatever an admin
                    adds after install. Say so HERE — this is the pre-install review, and a
                    reviewer who reads only the host list would otherwise be misled. */}
                {manifest.operatorEgress && (
                  <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] font-medium ${CHIP_PENDING}`}>
                    <Globe size={12} />{t('admin.plugins.operatorEgressPill')}
                  </span>
                )}
              </div>
              {manifest.operatorEgress && (
                <p className="mt-2 text-[11.5px] text-m-faint">{t('admin.plugins.operatorEgressHint')}</p>
              )}
            </div>
          )}

          {manifest && manifest.settings.length > 0 && (
            <div className="mt-5">
              <h4 className={sectionH}>{t('admin.plugins.setupTitle')}</h4>
              <ul className="mt-2 space-y-1.5">
                {manifest.settings.map(s => (
                  <li key={s.key} className="flex flex-wrap items-center gap-2 text-xs text-m-muted">
                    <span className="font-medium">{s.label}</span>
                    <span className="rounded-full bg-[color:var(--m-ic)] px-1.5 py-0.5 text-[10px] text-m-faint">{t(`admin.plugins.scope.${s.scope}` as never)}</span>
                    {s.required && <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${CHIP_PENDING}`}>{t('admin.plugins.fieldRequired')}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-5">
            <h4 className={sectionH}>{t('admin.plugins.detailsTitle')}</h4>
            <div className="mt-2.5 grid grid-cols-2 gap-x-6 gap-y-3">
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
              <h4 className={sectionH}>{t('admin.plugins.versionsTitle')}</h4>
              <div className="mt-2 space-y-0.5">
                {detail!.versions!.map(v => (
                  <div key={v.version} className="flex items-center gap-2.5 py-1">
                    <span className={`text-[12.5px] font-medium tabular-nums ${v.compatible ? 'text-m-ink' : 'text-m-faint'}`}>v{v.version}</span>
                    {v.publishedAt && <span className="text-[11.5px] text-m-faint">{new Date(v.publishedAt).toLocaleDateString(locale)}</span>}
                    {v.signed && <ShieldCheck size={13} className="shrink-0 text-[color:var(--m-st-confirmed)]" />}
                    <span className="ml-auto" />
                    {v.compatible ? (
                      !installed && (
                        <button type="button" onClick={() => onInstall(item.id, v.version)} disabled={busy === item.id}
                          className="rounded-full border border-[color:var(--m-rowbr)] px-2.5 py-1 text-[11.5px] font-bold text-m-muted disabled:opacity-50">
                          {t('admin.plugins.installCompatible', { version: v.version })}
                        </button>
                      )
                    ) : (
                      <span className="text-[11.5px] text-m-faint">{t('admin.plugins.versionNeedsTrek', { range: v.trek ?? '' })}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-none flex-wrap items-center gap-2 border-t border-[color:var(--m-rowbr)] px-4 py-3.5">
        <a href={repoUrl} target="_blank" rel="noreferrer" className={linkClass}>
          <Github size={13} /> {t('admin.plugins.sourceRepo')}
        </a>
        <a href={`${repoUrl}/issues`} target="_blank" rel="noreferrer" className={linkClass}>
          <CircleDot size={13} /> {t('admin.plugins.reportIssue')}
        </a>
        {homepage && (
          <a href={homepage} target="_blank" rel="noreferrer" className={linkClass}>
            <ExternalLink size={13} /> {t('admin.plugins.homepage')}
          </a>
        )}
      </div>
    </MSheet>
  )
}

function Meta({ k, v }: { k: string; v: string }) {
  return <div><div className="text-[12px] text-m-faint">{k}</div><div className="mt-0.5 text-[12.5px] font-medium text-m-ink">{v}</div></div>
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
function SignatureBlockSheet({ data, entry, busy, t, onRetrust, onClose }: {
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
    <MSheet open onClose={onClose} variant="card" material="opaque" ariaLabel={t('admin.plugins.sig.title', { name: data.subject.name })}>
      <div className="flex-none px-[18px] pt-[18px]">
        <div className="flex items-start gap-3">
          <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${CHIP_PENDING}`}><ShieldAlert size={18} /></div>
          <div>
            <h3 className="text-sm font-bold text-m-ink">{t('admin.plugins.sig.title', { name: data.subject.name })}</h3>
            <p className="mt-1 text-xs text-m-muted">{t(bodyKey as never)}</p>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4 space-y-4">
        {/* Fingerprints, not full keys: these exist to be COMPARED by a human — read the
            new one back to the author over the phone. The full key travels in the request. */}
        {canRetrust && (
          <div className="space-y-2">
            <KeyRow label={t('admin.plugins.sig.pinnedKey')} value={data.subject.keyFingerprint ?? '—'} />
            <KeyRow label={t('admin.plugins.sig.newKey')} value={fingerprint(newKey) ?? '—'} highlight />
            <p className="pt-1 text-[11.5px] leading-relaxed text-m-muted">{t('admin.plugins.sig.confirmOutOfBand')}</p>
          </div>
        )}
        {!canRetrust && data.detail && (
          <p className="break-all rounded-lg bg-[color:var(--m-ic)] px-3 py-2 font-mono text-xs text-m-faint">{data.detail}</p>
        )}
      </div>
      <div className="flex-none px-[18px] pb-[18px] flex items-center justify-end gap-2">
        <MAdminButton variant="ghost" onClick={onClose}>
          {offerRetrust ? t('admin.plugins.sig.cancel') : t('common.close')}
        </MAdminButton>
        {offerRetrust && (
          <MAdminButton variant="danger" busy={busy} onClick={() => onRetrust(version, newKey)}>
            {t('admin.plugins.sig.retrustConfirm')}
          </MAdminButton>
        )}
      </div>
    </MSheet>
  )
}

function KeyRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-2">
      <span className="shrink-0 text-[11.5px] text-m-muted">{label}</span>
      <code className={`break-all font-mono text-[12px] ${highlight ? 'font-semibold text-[color:var(--m-st-pending)]' : 'text-m-ink'}`}>{value}</code>
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

function UpdateConsentSheet({ data, unsigned, t, onApprove, onLater }: {
  data: { plugin: PluginRow; version: string; newPermissions: string[]; newEgress: string[] }
  unsigned: boolean
  t: T; onApprove: () => void; onLater: () => void
}) {
  return (
    <MSheet open onClose={onLater} variant="card" material="opaque" ariaLabel={t('admin.plugins.updateConsentTitle')}>
      <div className="flex-none px-[18px] pt-[18px]">
        <div className="flex items-start gap-3">
          <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${CHIP_PENDING}`}><ShieldCheck size={18} /></div>
          <div>
            <h3 className="text-sm font-bold text-m-ink">{t('admin.plugins.updateConsentTitle')}</h3>
            <p className="mt-1 text-xs text-m-muted">{t('admin.plugins.updateConsentBody', { name: data.plugin.name, version: data.version })}</p>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4 space-y-4">
        {/* The admin is about to widen what this code may do — so say, right here, that
            nothing ties this code to its author. One line, no checkbox, no extra click:
            this informs, it does not block. */}
        {unsigned && (
          <p className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${CHIP_PENDING}`}>
            <ShieldAlert size={13} className="mt-0.5 shrink-0" />
            <span>{t('admin.plugins.sig.consentUnsigned')}</span>
          </p>
        )}
        {data.newPermissions.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-m-muted">{t('admin.plugins.updateNewPermissions')}</h4>
            <ul className="mt-2 space-y-1.5">
              {data.newPermissions.map(perm => (
                <li key={perm} className="flex items-start gap-2 text-xs text-m-muted"><Check size={13} className="mt-0.5 shrink-0 text-[color:var(--m-st-pending)]" /><PermLabel perm={perm} t={t} /></li>
              ))}
            </ul>
          </div>
        )}
        {data.newEgress.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-m-muted">{t('admin.plugins.updateNewEgress')}</h4>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {data.newEgress.map(host => <code key={host} className="rounded bg-[color:var(--m-ic)] px-1.5 py-0.5 font-mono text-[11px] text-m-muted">{host}</code>)}
            </div>
          </div>
        )}
      </div>
      <div className="flex-none px-[18px] pb-[18px] flex items-center justify-end gap-2">
        <MAdminButton variant="ghost" onClick={onLater}>{t('admin.plugins.updateLater')}</MAdminButton>
        <MAdminButton onClick={onApprove}>{t('admin.plugins.updateApprove')}</MAdminButton>
      </div>
    </MSheet>
  )
}

// Shown when enabling a plugin is blocked by missing/outdated plugin dependencies.
// Each dependency gets a one-click download (latest version satisfying its range,
// transitively) that then retries enabling the plugin.
function DependencyResolveSheet({ data, t, busy, installedIds, onDownload, onClose }: {
  data: { plugin: PluginRow; missing: PluginDep[]; versionMismatch: VersionMismatch[] }
  t: T; busy: boolean; installedIds: Set<string>
  onDownload: (depId: string, constraint?: string) => void; onClose: () => void
}) {
  const rows: Array<{ id: string; constraint: string; installed?: string }> = [
    ...data.missing.map(d => ({ id: d.id, constraint: d.version })),
    ...data.versionMismatch.map(d => ({ id: d.id, constraint: d.wanted, installed: d.installed })),
  ]
  return (
    <MSheet open onClose={onClose} variant="card" material="opaque" ariaLabel={t('admin.plugins.dep.resolveTitle')}>
      <div className="flex-none px-[18px] pt-[18px]">
        <div className="flex items-start gap-3">
          <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${CHIP_PENDING}`}><Puzzle size={18} /></div>
          <div>
            <h3 className="text-sm font-bold text-m-ink">{t('admin.plugins.dep.resolveTitle')}</h3>
            <p className="mt-1 text-xs text-m-muted">{t('admin.plugins.dep.resolveBody', { name: data.plugin.name })}</p>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4 space-y-2.5">
        {rows.map(r => (
          <div key={r.id} className="flex items-center gap-3 rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] p-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-m-ink">{r.id}</div>
              <div className="mt-0.5 text-[11.5px] text-m-muted">
                {r.installed
                  ? t('admin.plugins.dep.mismatch', { wanted: r.constraint, installed: r.installed })
                  : t('admin.plugins.dep.requires', { version: r.constraint })}
              </div>
            </div>
            <button type="button" onClick={() => onDownload(r.id, r.constraint)} disabled={busy}
              className={`shrink-0 ${ACT_PILL}`}>
              <Download size={13} /> {r.installed ? t('admin.plugins.dep.update') : t('admin.plugins.dep.download')}
            </button>
          </div>
        ))}
        {rows.some(r => !installedIds.has(r.id)) && (
          <p className="pt-1 text-[11.5px] text-m-faint">{t('admin.plugins.dep.resolveHint')}</p>
        )}
      </div>
      <div className="flex-none px-[18px] pb-[18px] flex items-center justify-end">
        <MAdminButton variant="ghost" onClick={onClose}>{t('common.cancel')}</MAdminButton>
      </div>
    </MSheet>
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
    <div className="overflow-hidden rounded-[18px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)]">
      <div className="flex items-start gap-2 px-4 py-3.5">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-m-faint" />
        <p className="text-xs text-m-muted">{t('admin.plugins.reviewedMeaning')}</p>
      </div>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex w-full items-center justify-between gap-2 border-t border-[color:var(--m-rowbr)] px-4 py-3 text-xs font-medium text-m-muted">
        <span className="flex items-center gap-2"><Lock size={13} className="shrink-0" /> <span className="text-left">{t('admin.plugins.security.title')}</span></span>
        <ChevronDown size={15} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="grid gap-x-8 gap-y-4 border-t border-[color:var(--m-rowbr)] px-4 py-4">
          {sections.map(([h, b]) => (
            <div key={h}>
              <h4 className="text-[12.5px] font-semibold text-m-ink">{t(h as never)}</h4>
              <p className="mt-1 text-xs leading-relaxed text-m-muted">{t(b as never)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
