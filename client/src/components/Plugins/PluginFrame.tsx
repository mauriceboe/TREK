import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from '../../i18n'
import ErrorBoundary from '../shared/ErrorBoundary'
import { useAuthStore } from '../../store/authStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useTripStore } from '../../store/tripStore'
import { usePluginStore } from '../../store/pluginStore'
import { useToast } from '../shared/Toast'
import ConfirmDialog from '../shared/ConfirmDialog'
import { pluginsApi } from '../../api/client'
import { addListener, removeListener } from '../../api/websocket'
import { useIsPhone } from '../../mobile/useIsPhone'

// The design-token contract handed to plugins (#4 richer context): non-secret CSS
// values, resolved for the CURRENT theme, so a plugin can match TREK exactly (and
// re-match on a theme toggle / accent change) instead of hard-coding a mirror of
// the palette that drifts. Names mirror index.css so a plugin can apply them
// verbatim as CSS variables. This is the whole GLOBAL (:root/.dark) palette — the
// part that a user can recolour via appearance settings (accent scheme, custom
// accent, high-contrast) flows through here live. The glassy `.trek-dash` layer
// (--glass-*/--r-*/--sh-*) is intentionally NOT read here: it is scoped to the
// dashboard subtree, so it resolves EMPTY at documentElement — the SDK design kit
// bakes those values instead (they don't vary with the accent, only light/dark).
/**
 * The mobile palette (client/src/mobile/mobile.css) is a SECOND, unrelated token
 * family, and it is scoped to `.m-root` rather than to the document element. That
 * scope is the reason it cannot simply join the list below: `readThemeTokens`
 * measures at documentElement, where every one of these resolves empty — the same
 * trap the comment above describes for `--glass-*`. They are read off the mobile
 * shell instead, when one is mounted.
 *
 * A plugin sitting inside the mobile shell needs these to match its surroundings;
 * the global palette above describes the desktop chrome and looks foreign there.
 */
const MOBILE_TOKEN_VARS = [
  // ink + ground
  '--m-ink', '--m-muted', '--m-faint', '--m-bg', '--m-scr',
  // glass surfaces the mobile design is built from
  '--m-glass', '--m-gbr', '--m-card', '--m-cbr', '--m-inner', '--m-inbr',
  '--m-sheet', '--m-sheetop', '--m-shbr',
  // action + accents
  '--m-act', '--m-actfg', '--m-dim', '--m-ic', '--m-rowbr', '--m-avbr', '--m-knob',
  // status canon (theme independent, but a plugin should not restate it)
  '--m-st-confirmed', '--m-st-pending', '--m-st-info', '--m-st-danger', '--m-st-neutral',
  // chrome metrics
  '--m-safe-top',
]

const TOKEN_VARS = [
  // surfaces
  '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-elevated',
  '--bg-card', '--bg-input', '--bg-hover', '--bg-selected', '--bg-inverse',
  // text
  '--text-primary', '--text-secondary', '--text-muted', '--text-faint', '--text-inverse',
  // borders
  '--border-primary', '--border-secondary', '--border-faint',
  // accent (recoloured by the chosen scheme / custom accent)
  '--accent', '--accent-text', '--accent-on', '--accent-hover', '--accent-subtle',
  // semantic + soft fills
  '--success', '--success-soft', '--danger', '--danger-soft',
  '--warning', '--warning-soft', '--info', '--info-soft',
  // shadows
  '--shadow-card', '--shadow-elevated', '--shadow-sm', '--shadow-md', '--shadow-lg',
  // radii, type, misc
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl',
  '--font-system', '--font-subtext', '--overlay', '--ease-out-quint',
  // How much a host surface keeps clear at the bottom. Global, unlike the rest of
  // the mobile metrics, and useful on both form factors.
  '--bottom-nav-h',
]
function readThemeTokens(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const out: Record<string, string> = {}
  for (const v of TOKEN_VARS) {
    const val = cs.getPropertyValue(v).trim()
    if (val) out[v] = val
  }
  // Measured on the mobile shell, because that is where the mobile palette is
  // declared. Absent on desktop, and then these keys are simply absent too — a
  // plugin checks for them rather than assuming both families are present.
  const mobileRoot = document.querySelector('.m-root')
  if (mobileRoot) {
    const mcs = getComputedStyle(mobileRoot)
    for (const v of MOBILE_TOKEN_VARS) {
      const val = mcs.getPropertyValue(v).trim()
      if (val) out[v] = val
    }
  }
  return out
}

/** Where a frame is mounted. Part of the plugin contract, so the names are stable. */
export type PluginSurface =
  | 'trip-tab'        // a plugin's own tab inside a trip (fills, scrolls itself)
  | 'plugin-page'     // /plugins/:id (fills, scrolls itself)
  | 'dashboard-widget'// a card on the dashboard (reports its height)
  | 'user-settings'   // the plugin's settings.html (reports its height)
  | 'detail-slot'     // inside a place/day/reservation panel (reports its height)
  | 'action-frame'    // the modal a table action opens (fills)

/**
 * What the host already keeps clear around this frame, in CSS pixels.
 *
 * This describes space the plugin does NOT have to account for; it is not a
 * request to add padding. The mobile trip tab is the only surface with floating
 * chrome above and below it, and the numbers come from the same variables the
 * native tabs use, so the two can never drift apart.
 */
function readInsets(surface: PluginSurface | undefined, phone: boolean): { top: number; bottom: number } {
  if (!phone || surface !== 'trip-tab') return { top: 0, bottom: 0 }
  const mobileRoot = document.querySelector('.m-root')
  if (!mobileRoot) return { top: 0, bottom: 0 }
  const cs = getComputedStyle(mobileRoot)
  const px = (value: string, fallback: number) => {
    const n = Number.parseFloat(value)
    return Number.isFinite(n) ? n : fallback
  }
  // Mirrors TabScroller: the controls end 58px below the safe-top anchor, and the
  // dock plus its breathing room is what --bottom-nav-h already expresses.
  return {
    top: px(cs.getPropertyValue('--m-safe-top'), 12) + 58,
    bottom: px(cs.getPropertyValue('--bottom-nav-h'), 84) + 22,
  }
}

/**
 * The host's current appearance state, mirrored from the attributes applyAppearance
 * writes on <html>, so a plugin can honour the same accessibility/appearance choices
 * inside its own sandboxed document (it can't read the parent DOM). All booleans/enums
 * — nothing secret.
 */
function readAppearance() {
  const el = document.documentElement
  return {
    scheme: el.dataset.scheme || 'default',
    density: el.dataset.density === 'compact' ? 'compact' : 'comfortable',
    noTransparency: el.hasAttribute('data-no-transparency'),
    reducedMotion:
      el.hasAttribute('data-reduce-motion') ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  }
}

/**
 * Renders a plugin's sandboxed page/widget iframe and hosts the trekBridge
 * (#plugins, M3).
 *
 * The frame is served same-origin from /plugin-frame/:id but sandboxed WITHOUT
 * allow-same-origin, so it runs at an OPAQUE origin: no access to the trek_session
 * cookie, no parent DOM, no credentialed fetch. Its only channel is postMessage,
 * and we authenticate every inbound message by the SENDER WINDOW IDENTITY
 * (event.source === our iframe), never by a claimed id or by origin (which is
 * "null" for opaque frames). Data reads go through the host (app-origin, session
 * cookie) so the plugin never handles credentials.
 */

interface PluginFrameProps {
  pluginId: string
  tripId?: string | null
  /** The place in view — set for a place-detail slot so the plugin can scope to it. */
  placeId?: string | null
  /** The day in view — set for a day-detail slot so the plugin can scope to it. */
  dayId?: string | null
  /** The reservation in view — set for a reservation-detail slot so the plugin can scope to it. */
  reservationId?: string | null
  /**
   * Full-page hosts (trip tab, /plugins/:id) set this so the frame always fills
   * its container. Without it a kit-based plugin auto-reports its content height
   * (trek:resize) and the page collapses to a floating island with dead space
   * below — right for dashboard widgets, wrong for a page.
   */
  fill?: boolean
  /**
   * Which host surface this frame is mounted in. Handed to the plugin verbatim,
   * because the contract differs per surface and a plugin cannot see where it
   * sits: a page fills and scrolls itself, a widget reports its height and gets
   * it honoured, a detail slot is a narrow column inside someone else's panel.
   */
  surface?: PluginSurface
  className?: string
  title?: string
  /**
   * Entry document inside the plugin's client/ dir. Defaults to the widget's
   * index.html; the user-settings surface loads settings.html instead. Host-set
   * literals only — never user input (it becomes part of the frame URL).
   */
  path?: string
}

type PluginSessionStorageScope = 'plugin' | 'trip'

type Inbound =
  | { type: 'trek:ready' }
  | { type: 'trek:context:request' }
  | { type: 'trek:navigate'; to: string }
  | { type: 'trek:notify'; level?: 'info' | 'success' | 'warning' | 'error'; message?: string; duration?: number }
  | { type: 'trek:resize'; height?: number }
  | { type: 'trek:invoke'; requestId: string; sub: string; method?: string; body?: unknown }
  | { type: 'trek:session:get'; requestId: string; key: string; scope?: PluginSessionStorageScope }
  | { type: 'trek:session:set'; requestId: string; key: string; value: unknown; scope?: PluginSessionStorageScope }
  | { type: 'trek:session:remove'; requestId: string; key: string; scope?: PluginSessionStorageScope }
  | { type: 'trek:session:clear'; requestId: string; scope?: PluginSessionStorageScope }
  | { type: 'trek:confirm'; requestId: string; title?: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
  | { type: 'trek:openExternal'; url?: string }
  | { type: 'trek:geolocation'; requestId: string; action?: 'get' | 'watch' | 'clear' }

/** The wire shape of a position sent to the frame — plain data, no prototype. */
function geoPosition(p: GeolocationPosition) {
  return {
    lat: p.coords.latitude,
    lng: p.coords.longitude,
    accuracy: p.coords.accuracy,
    heading: p.coords.heading,
    speed: p.coords.speed,
    timestamp: p.timestamp,
  }
}

function geoErrorCode(e: GeolocationPositionError): 'denied' | 'unavailable' | 'timeout' {
  return e.code === e.PERMISSION_DENIED ? 'denied' : e.code === e.TIMEOUT ? 'timeout' : 'unavailable'
}

interface ConfirmRequest {
  requestId: string
  title?: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  danger: boolean
}

const PLUGIN_SESSION_NAMESPACE = 'trek:plugin-session:'
const PLUGIN_SESSION_MAX_KEY_LENGTH = 64
const PLUGIN_SESSION_MAX_KEYS = 32
const PLUGIN_SESSION_MAX_VALUE_BYTES = 1024

/**
 * Returns all host-owned storage keys in one plugin scope (plugin-wide or a
 * specific trip), excluding TREK state and every other plugin/scope.
 */
function getScopedSessionKeys(scopeKeyPrefix: string) {
  const keys: string[] = []
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i)
    if (key?.startsWith(scopeKeyPrefix)) keys.push(key)
  }
  return keys
}

/**
 * Creates the prefix and full key for host-owned plugin session storage.
 *
 *   Storage Keys:
 *   trek:plugin-session:{userId}:{pluginId}:plugin:{key}
 *   trek:plugin-session:{userId}:{pluginId}:trip:{tripId}:{key}
 *
 *   Scope Prefix:
 *   trek:plugin-session:{userId}:{pluginId}:plugin
 *   trek:plugin-session:{userId}:{pluginId}:trip:{tripId}
 *
 *   Plugin Prefix:
 *   trek:plugin-session:{userId}:{pluginId}
 *
 *
 * Each dynamic segment is URI-encoded, so plugin-controlled values cannot alter
 * the key format. For clear, omit logicalKey; the returned full key is then
 * the same as the scoped prefix.
 */
function createPluginSessionStorageKeys(
  userId: string | number | null,
  pluginId: string,
  scope: PluginSessionStorageScope,
  tripId: string | null,
  logicalKey?: string,
) {
  const pluginKeyPrefix = `${PLUGIN_SESSION_NAMESPACE}${encodeURIComponent(String(userId))}:${encodeURIComponent(pluginId)}:`

  // Scope is either :plugin: or :trip:${tripId}:
  const scopeSegment = scope === 'trip' ? `trip:${encodeURIComponent(tripId!)}` : 'plugin'
  const scopeKeyPrefix = `${pluginKeyPrefix}${scopeSegment}:`

  const encodedLogicalKey = logicalKey === undefined ? undefined : encodeURIComponent(logicalKey)
  const storageKey = encodedLogicalKey === undefined ? scopeKeyPrefix : `${scopeKeyPrefix}${encodedLogicalKey}`
  return {
    pluginKeyPrefix,
    scopeKeyPrefix,
    storageKey,
  }
}

export default function PluginFrame({ pluginId, tripId = null, placeId = null, dayId = null, reservationId = null, fill = false, surface, className, title, path = 'index.html' }: PluginFrameProps) {
  const isPhone = useIsPhone()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  // A sandboxed frame may navigate ITSELF (connect-src can't stop that), and its
  // window identity keeps matching our iframe afterwards. Track loads and refuse
  // the bridge once a second document loads. NOTE: this is best-effort — the load
  // event fires at end-of-document, so a navigated attacker doc that posts during
  // its own load (or holds it open) can still reach the bridge for one exchange.
  // The exposure is bounded (only this plugin's own routes + the trek:context
  // ids the plugin already had; never the httpOnly cookie); fully closing it
  // would require not running plugin client JS at all.
  const loadsRef = useRef(0)
  const { locale, t } = useTranslation()
  const navigate = useNavigate()
  const toast = useToast()
  // useToast returns a fresh object every render; keep it out of the effect deps
  // (via this ref) or the bridge effect would tear down and re-post the context on
  // EVERY parent re-render instead of only when the context inputs change.
  const toastRef = useRef(toast)
  toastRef.current = toast
  const userId = useAuthStore((s) => s.user?.id)
  const userName = useAuthStore((s) => s.user?.username ?? null)
  const userAvatar = useAuthStore((s) => s.user?.avatar_url ?? null)
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin')
  const settings = useSettingsStore((s) => s.settings)
  // Plugins format money against a concrete code, so resolve the same chain Costs
  // uses: the user's display currency, else the trip's own.
  const tripCurrency = useTripStore((s) => s.trip?.currency)
  const displayCurrency = (settings.default_currency || tripCurrency || 'EUR').toUpperCase()
  const [height, setHeight] = useState<number | null>(null)
  // A host-rendered ConfirmDialog on the plugin's behalf: sandboxed frames have no
  // allow-modals and can't overlay the host, so destructive plugin actions get the
  // same native confirm every TREK feature uses. One at a time; extras are refused.
  // The ref mirrors the state so the message handler can gate + answer without
  // side effects inside a setState updater (StrictMode runs updaters twice).
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)
  // The iframe document can fail to load on its own: a plugin uninstalled in
  // another tab, a frame route the host no longer serves, a network blip on a
  // lazily loaded frame. Without an onError the element just stays blank at full
  // height, which reads as a hung app rather than as a plugin that is gone.
  const [loadFailed, setLoadFailed] = useState(false)
  const confirmReqRef = useRef<ConfirmRequest | null>(null)
  // geolocation:read gate — the feed only flags plugins whose grant is recorded.
  // Read via ref (like toastRef) so the bridge effect doesn't re-run on store churn.
  const geoAllowed = usePluginStore((s) => s.getById(pluginId)?.geolocation === true)
  const geoAllowedRef = useRef(geoAllowed)
  geoAllowedRef.current = geoAllowed
  // The single live watchPosition of this frame (id from navigator.geolocation).
  const geoWatchRef = useRef<number | null>(null)

  // opaque frame -> targetOrigin must be '*'. Hoisted so the iframe's onLoad can
  // deliver the context too: the trek:ready handshake alone is racy — if the frame
  // boots before the effect's listener attaches, the plugin never learns the theme
  // and falls back to the OS scheme (dark mode looking "off" until a toggle).
  const postFrame = useCallback((msg: unknown) => frameRef.current?.contentWindow?.postMessage(msg, '*'), [])
  const buildContext = useCallback(() => ({
    type: 'trek:context',
    tripId,
    placeId,
    dayId,
    reservationId,
    userId: userId != null ? String(userId) : null,
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    locale,
    // Mirror of what TranslationProvider stamps on <html> — an RTL host (Arabic)
    // wants RTL plugin UIs too, and the frame can't read our DOM to find out.
    dir: (document.documentElement.getAttribute('dir') === 'rtl' ? 'rtl' : 'ltr') as 'rtl' | 'ltr',
    hostOrigin: window.location.origin,
    // #4 richer context — non-secret display data so plugins render natively:
    // who the user is (name/avatar/isAdmin — never email/role beyond a boolean),
    // how TREK formats things, the resolved theme tokens, and the appearance state
    // (accent scheme, density, reduced-motion / no-transparency) so a plugin can
    // mirror the same look and accessibility choices as the host.
    user: userName != null ? { name: userName, avatar: userAvatar, isAdmin } : null,
    appearance: readAppearance(),
    // Where this frame sits and what shape it is expected to take. Without it a
    // plugin cannot tell a full-height tab from a widget that reports its own
    // height, and a height report is silently dropped on a filling surface.
    viewport: {
      surface: surface ?? null,
      formFactor: isPhone ? 'phone' : 'desktop',
      fill,
      insets: readInsets(surface, isPhone),
    },
    formats: {
      locale,
      currency: displayCurrency,
      timeFormat: settings.time_format,
      distanceUnit: settings.distance_unit,
      temperatureUnit: settings.temperature_unit,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      blurBookingCodes: Boolean(settings.blur_booking_codes),
    },
    tokens: readThemeTokens(),
  }), [tripId, placeId, dayId, reservationId, userId, locale, userName, userAvatar, isAdmin, settings, surface, fill, isPhone])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return

    const post = postFrame
    const context = buildContext

    const onMessage = async (ev: MessageEvent) => {
      // The ONLY trusted identity: the message came from OUR iframe's window.
      if (ev.source !== frame.contentWindow) return
      // …AND that window still holds the original plugin document (loaded once).
      // A 2nd load means the frame navigated elsewhere — stop bridging to it.
      if (loadsRef.current > 1) return
      const msg = ev.data as Inbound
      if (!msg || typeof msg !== 'object') return

      switch (msg.type) {
        case 'trek:ready':
        case 'trek:context:request':
          post(context())
          break
        case 'trek:navigate': {
          const to = typeof msg.to === 'string' ? msg.to : ''
          // In-app paths only; block protocol-relative and admin unless allowed by the app itself.
          if (/^\/[a-zA-Z0-9/_?=&%.-]*$/.test(to) && !to.startsWith('//')) navigate(to)
          break
        }
        case 'trek:notify': {
          const text = String(msg.message ?? '').slice(0, 200)
          const level = msg.level ?? 'info'
          if (!text) break
          const t = toastRef.current
          const show = t[level] ?? t.info
          // Optional duration, clamped so a plugin can neither flash nor park a
          // toast (isFinite: NaN would slip through the clamp as duration 0 = sticky).
          if (Number.isFinite(msg.duration)) show(text, Math.min(Math.max(msg.duration as number, 1500), 15000))
          else show(text)
          break
        }
        case 'trek:confirm': {
          if (typeof msg.requestId !== 'string' || !msg.requestId) break
          if (confirmReqRef.current) {
            // One dialog at a time — answer the newcomer 'not confirmed' right away.
            post({ type: 'trek:confirm:result', requestId: msg.requestId, confirmed: false })
            break
          }
          const req: ConfirmRequest = {
            requestId: msg.requestId,
            title: typeof msg.title === 'string' ? msg.title.slice(0, 120) : undefined,
            message: typeof msg.message === 'string' ? msg.message.slice(0, 500) : undefined,
            confirmLabel: typeof msg.confirmLabel === 'string' ? msg.confirmLabel.slice(0, 40) : undefined,
            cancelLabel: typeof msg.cancelLabel === 'string' ? msg.cancelLabel.slice(0, 40) : undefined,
            danger: msg.danger !== false,
          }
          confirmReqRef.current = req
          setConfirmReq(req)
          break
        }
        case 'trek:openExternal': {
          // The sandbox has no allow-popups, so the HOST opens the link — but only
          // real web URLs, never javascript:/data:/file: or anything else.
          try {
            const u = new URL(String(msg.url ?? ''))
            if (u.protocol === 'https:' || u.protocol === 'http:') {
              window.open(u.href, '_blank', 'noopener,noreferrer')
            }
          } catch { /* not a URL — ignore */ }
          break
        }
        case 'trek:resize':
          if (!fill && typeof msg.height === 'number' && msg.height > 0) setHeight(Math.min(msg.height, 2000))
          break
        case 'trek:invoke': {
          // The plugin's own route, called host-side with the user's session.
          try {
            const data = await pluginsApi.invoke(pluginId, msg.sub, { method: msg.method, body: msg.body })
            post({ type: 'trek:response', requestId: msg.requestId, data })
          } catch (e) {
            const err = e as { response?: { status?: number }; message?: string }
            post({ type: 'trek:error', requestId: msg.requestId, code: err.response?.status ?? 'error', message: err.message ?? 'invoke failed' })
          }
          break
        }
        case 'trek:geolocation': {
          // The sandbox blocks navigator.geolocation inside the frame (deliberately —
          // no blanket permissions-policy delegation). The HOST reads the position and
          // posts plain data, gated on the plugin's geolocation:read grant, and the
          // browser's own site permission prompt still applies on top. Nothing here
          // reaches the server — the position only travels parent → this frame.
          if (typeof msg.requestId !== 'string' || !msg.requestId) break
          const requestId = msg.requestId
          const fail = (error: string) => post({ type: 'trek:geolocation:result', requestId, error })
          if (!geoAllowedRef.current) { fail('forbidden'); break }
          if (!('geolocation' in navigator)) { fail('unsupported'); break }
          const action = msg.action ?? 'get'
          if (action === 'clear') {
            if (geoWatchRef.current != null) { navigator.geolocation.clearWatch(geoWatchRef.current); geoWatchRef.current = null }
            post({ type: 'trek:geolocation:result', requestId, cleared: true })
            break
          }
          const geoOpts = { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
          if (action === 'watch') {
            // One watch per frame — a new request replaces the old one. Confirmed
            // immediately; positions stream as trek:geolocation:update messages.
            if (geoWatchRef.current != null) navigator.geolocation.clearWatch(geoWatchRef.current)
            post({ type: 'trek:geolocation:result', requestId, watching: true })
            // Re-check the grant on every fix, not just at start: if an admin revokes
            // geolocation:read while the frame stays open, the stream stops at once.
            const stillAllowed = () => {
              if (geoAllowedRef.current) return true
              if (geoWatchRef.current != null) { navigator.geolocation.clearWatch(geoWatchRef.current); geoWatchRef.current = null }
              return false
            }
            geoWatchRef.current = navigator.geolocation.watchPosition(
              (p) => { if (loadsRef.current <= 1 && stillAllowed()) post({ type: 'trek:geolocation:update', position: geoPosition(p) }) },
              (e) => { if (loadsRef.current <= 1 && stillAllowed()) post({ type: 'trek:geolocation:update', error: geoErrorCode(e) }) },
              geoOpts,
            )
            break
          }
          navigator.geolocation.getCurrentPosition(
            (p) => { if (loadsRef.current <= 1) post({ type: 'trek:geolocation:result', requestId, position: geoPosition(p) }) },
            (e) => { if (loadsRef.current <= 1) fail(geoErrorCode(e)) },
            geoOpts,
          )
          break
        }
        case 'trek:session:clear': {
          // Same guard the other request/response handlers apply: without an id
          // the frame could never match our answer to its call.
          if (typeof msg.requestId !== 'string' || !msg.requestId) break
          const scope = msg.scope === 'trip' ? 'trip' : 'plugin'

          // tripId required if we are on a trip-scoped key.
          if (scope === 'trip' && tripId == null) {
            post({ type: 'trek:error', requestId: msg.requestId, code: 'NO_TRIP_CONTEXT', message: 'trip session storage requires a trip context' })
            break
          }

          const { scopeKeyPrefix } = createPluginSessionStorageKeys(userId, pluginId, scope, tripId)
          try {
            getScopedSessionKeys(scopeKeyPrefix).forEach((storageKey) => sessionStorage.removeItem(storageKey))
            post({ type: 'trek:response', requestId: msg.requestId, data: undefined })
          } catch (error) {
            const message = error instanceof Error ? error.message : 'session storage failed'
            post({ type: 'trek:error', requestId: msg.requestId, code: 'SESSION_STORAGE_ERROR', message })
          }
          break
        }
        case 'trek:session:get':
        case 'trek:session:set':
        case 'trek:session:remove': {
          if (typeof msg.requestId !== 'string' || !msg.requestId) break
          const scope = msg.scope === 'trip' ? 'trip' : 'plugin'
          if (scope === 'trip' && tripId == null) {
            post({ type: 'trek:error', requestId: msg.requestId, code: 'NO_TRIP_CONTEXT', message: 'trip session storage requires a trip context' })
            break
          }
          if (typeof msg.key !== 'string' || msg.key.length === 0 || msg.key.length > PLUGIN_SESSION_MAX_KEY_LENGTH) {
            post({ type: 'trek:error', requestId: msg.requestId, code: 'SESSION_INVALID_KEY', message: `session key must be 1-${PLUGIN_SESSION_MAX_KEY_LENGTH} characters` })
            break
          }
          const { scopeKeyPrefix, storageKey } = createPluginSessionStorageKeys(userId, pluginId, scope, tripId, msg.key)
          try {
            if (msg.type === 'trek:session:get') {
              const storedValue = sessionStorage.getItem(storageKey)
              post({ type: 'trek:response', requestId: msg.requestId, data: storedValue === null ? undefined : JSON.parse(storedValue) })
              break
            }

            if (msg.type === 'trek:session:set') {
              const serializedValue = JSON.stringify(msg.value)
              if (serializedValue === undefined) {
                post({ type: 'trek:error', requestId: msg.requestId, code: 'SESSION_INVALID_VALUE', message: 'session value must be JSON-serialisable' })
                break
              }

              // Validate length based on unicode byte sizes
              const valueBytes = new TextEncoder().encode(serializedValue).byteLength
              if (valueBytes > PLUGIN_SESSION_MAX_VALUE_BYTES) {
                post({ type: 'trek:error', requestId: msg.requestId, code: 'SESSION_VALUE_TOO_LARGE', message: `session value exceeds ${PLUGIN_SESSION_MAX_VALUE_BYTES} bytes` })
                break
              }
              const keys = getScopedSessionKeys(scopeKeyPrefix)
              if (!keys.includes(storageKey) && keys.length >= PLUGIN_SESSION_MAX_KEYS) {
                post({ type: 'trek:error', requestId: msg.requestId, code: 'SESSION_KEY_LIMIT', message: `plugin session storage allows at most ${PLUGIN_SESSION_MAX_KEYS} keys` })
                break
              }
              sessionStorage.setItem(storageKey, serializedValue)
              post({ type: 'trek:response', requestId: msg.requestId, data: undefined })
              break
            }

            sessionStorage.removeItem(storageKey)
            post({ type: 'trek:response', requestId: msg.requestId, data: undefined })
          } catch (error) {
            const message = error instanceof Error ? error.message : 'session storage failed'
            post({ type: 'trek:error', requestId: msg.requestId, code: 'SESSION_STORAGE_ERROR', message })
          }
          break
        }
      }
    }

    window.addEventListener('message', onMessage)

    // Live locale/format sync: this effect re-runs whenever buildContext's inputs
    // (locale, settings, trip/place) change, so a loaded frame gets the fresh
    // context pushed instead of staying stale until reload. First delivery is
    // handled by onLoad; navigated frames (loads > 1) are never re-bridged.
    if (loadsRef.current === 1) post(context())

    // Forward event *names* for the trip in view, mirroring the server-side events
    // surface: only { event, tripId }, never payloads — the frame's user is already
    // looking at this trip. Core events plus the plugin's OWN namespaced broadcasts
    // (plugin:{id}:*) pass; other plugins' broadcasts don't. Trip events only reach
    // the socket while a planner has the trip joined, so this is a planner-side
    // refresh signal — dashboard widgets still poll.
    let wsForward: ((ev: Record<string, unknown>) => void) | null = null
    if (tripId) {
      wsForward = (ev) => {
        if (loadsRef.current !== 1) return
        if (!ev || typeof ev.type !== 'string' || ev.tripId == null || String(ev.tripId) !== tripId) return
        if (ev.type.startsWith('plugin:') && !ev.type.startsWith(`plugin:${pluginId}:`)) return
        post({ type: 'trek:event', event: ev.type, tripId })
      }
      addListener(wsForward)
    }

    // The frame is opaque-origin and can't read our DOM, and we otherwise send the
    // context (incl. theme + tokens) only once on trek:ready — so a plugin can't
    // follow an in-app appearance change. Watch the <html> element for anything
    // applyAppearance touches (the `dark` class, the data-* appearance attributes,
    // and inline style for the custom-accent vars) and re-post the context when the
    // resulting look actually changes, so plugins restyle live. A compact signature
    // dedupes: unrelated mutations don't trigger a repost. (Plugins re-apply on
    // trek:context.)
    const htmlEl = document.documentElement
    const appearanceSig = () => {
      const cs = getComputedStyle(htmlEl)
      return [
        htmlEl.classList.contains('dark'),
        htmlEl.dataset.scheme || '',
        htmlEl.dataset.density || '',
        htmlEl.hasAttribute('data-no-transparency'),
        htmlEl.hasAttribute('data-reduce-motion'),
        cs.getPropertyValue('--accent').trim(),
      ].join('|')
    }
    let prevSig = appearanceSig()
    const themeObserver = new MutationObserver(() => {
      const sig = appearanceSig()
      if (sig === prevSig) return
      prevSig = sig
      if (loadsRef.current <= 1) post(context())
    })
    themeObserver.observe(htmlEl, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-scheme', 'data-density', 'data-no-transparency', 'data-reduce-motion'],
    })

    return () => {
      window.removeEventListener('message', onMessage)
      themeObserver.disconnect()
      if (wsForward) removeListener(wsForward)
    }
  }, [pluginId, tripId, fill, navigate, postFrame, buildContext, userId])

  // Hosts swap pluginId in place (tab bar, /plugins/:id route) — the iframe below
  // is keyed so the document is a fresh first load, and the per-plugin bridge
  // state must start over with it or the new plugin would be refused as a
  // "navigated" frame (loads > 1) and an open confirm would leak across plugins.
  useEffect(() => {
    loadsRef.current = 0
    setHeight(null)
    confirmReqRef.current = null
    setConfirmReq(null)
    // Only a real teardown may kill the watch: the bridge above re-runs on any
    // settings, locale or breakpoint change, and nothing would re-arm it.
    return () => {
      if (geoWatchRef.current != null) { navigator.geolocation.clearWatch(geoWatchRef.current); geoWatchRef.current = null }
    }
  }, [pluginId])

  const answerConfirm = (confirmed: boolean) => {
    const req = confirmReqRef.current
    if (req) postFrame({ type: 'trek:confirm:result', requestId: req.requestId, confirmed })
    confirmReqRef.current = null
    setConfirmReq(null)
  }

  // The dialog title always leads with the host-controlled plugin name, so a
  // plugin cannot dress its confirm up as a TREK system dialog.
  const pluginLabel = title || pluginId
  const confirmTitle = confirmReq?.title ? `${pluginLabel} — ${confirmReq.title}` : pluginLabel

  return (
    // Third-party code: a throw in here must cost the plugin, not the page.
    <ErrorBoundary boundaryId="plugin-frame" label={pluginLabel} resetKeys={[pluginId]}>
      <>
        <iframe
          key={pluginId}
          ref={frameRef}
          src={`/plugin-frame/${pluginId}/${path}`}
          // Deliver the context as soon as the document is parsed (the plugin sets up its
          // message listener during parse), closing the trek:ready race so the theme is
          // right on first paint. A 2nd load is a self-navigation — don't bridge to it.
          onLoad={() => {
            setLoadFailed(false)
            loadsRef.current += 1
            if (loadsRef.current === 1) postFrame(buildContext())
            // A self-navigated frame is no longer bridged, so its watch is only
            // burning battery for positions nobody receives.
            else if (geoWatchRef.current != null) { navigator.geolocation.clearWatch(geoWatchRef.current); geoWatchRef.current = null }
          }}
          onError={() => setLoadFailed(true)}
          sandbox="allow-scripts allow-forms"
          allowFullScreen
          allow="fullscreen"
          referrerPolicy="no-referrer"
          loading="lazy"
          title={title || pluginId}
          className={className}
          style={{ width: '100%', height: fill ? '100%' : height ?? '100%', border: 0, display: loadFailed ? 'none' : undefined }}
        />
        {loadFailed && (
          <div
            role="alert"
            className="flex items-center justify-center rounded-xl border border-edge bg-surface-2 p-6 text-caption text-content-2"
            style={{ width: '100%', height: fill ? '100%' : height ?? '100%' }}
          >
            {t('plugins.frameLoadFailed')}
          </div>
        )}
        <ConfirmDialog
          isOpen={confirmReq != null}
          onClose={() => answerConfirm(false)}
          onConfirm={() => answerConfirm(true)}
          title={confirmTitle}
          message={confirmReq?.message}
          confirmLabel={confirmReq?.confirmLabel}
          cancelLabel={confirmReq?.cancelLabel}
          danger={confirmReq?.danger}
        />
      </>
    </ErrorBoundary>
  )
}
