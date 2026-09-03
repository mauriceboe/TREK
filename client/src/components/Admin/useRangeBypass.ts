import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from '../../i18n'

type T = (k: string, p?: Record<string, unknown>) => string

/** The server's "this only went through because TREK_PLUGINS_IGNORE_TREK_RANGE is set" marker. */
export interface TrekRangeBypass { trekRange: string | null; hostVersion: string }
/** What the range-bypass warning needs to say, and what to do if the admin accepts (null = a notice). */
export interface RangeWarning extends TrekRangeBypass { name: string; onConfirm: (() => void) | null }

/**
 * The chip a row carries while it runs outside its declared range on the operator's
 * say-so. Not a blocker — the toggle works — but a warning that must outlive the install
 * dialog for as long as the plugin runs here. Null when nothing was bypassed.
 */
export function bypassChip(b: TrekRangeBypass | null | undefined, t: T) {
  if (!b) return null
  return {
    icon: AlertTriangle,
    label: b.trekRange
      ? t('admin.plugins.dep.trekBypassed', { range: b.trekRange, host: b.hostVersion })
      : t('admin.plugins.dep.trekBypassedUnknown'),
    blocked: false,
    warn: true,
  }
}

/**
 * The Install button for a registry entry the server flagged incompatible, once the
 * operator set TREK_PLUGINS_IGNORE_TREK_RANGE: the server will take the newest version
 * regardless, so the button says exactly that — and carries what the warning has to say
 * first. `title` is the shell's existing "why" line (needs TREK X — this server runs Y).
 */
export function bypassOffer(item: { name: string; trek?: string | null; hostVersion?: string }, t: T, title: string) {
  return {
    blocked: false,
    label: t('admin.plugins.installAnyway'),
    title,
    warn: { name: item.name, trekRange: item.trek ?? null, hostVersion: item.hostVersion ?? '?', onConfirm: null } as RangeWarning,
  }
}

/**
 * Title + body of the warning, for either mode: a CONFIRM step before a registry install
 * the server would otherwise refuse (`onConfirm` set), or a plain NOTICE after a path that
 * could not ask first — sideload, dev-link, update, dependency download. The copy is the
 * whole point: the admin is accepting that the author never vouched for this TREK and
 * that, in rare cases, that can cost them data.
 */
export function rangeWarningCopy(w: RangeWarning, t: T): { title: string; body: string; confirm: boolean } {
  const confirm = w.onConfirm !== null
  return {
    confirm,
    title: confirm ? t('admin.plugins.rangeBypass.title') : t('admin.plugins.rangeBypass.noticeTitle'),
    body: w.trekRange
      ? t('admin.plugins.rangeBypass.body', { name: w.name, range: w.trekRange, host: w.hostVersion })
      : t('admin.plugins.rangeBypass.bodyUnknown', { name: w.name, host: w.hostVersion }),
  }
}

/**
 * The TREK_PLUGINS_IGNORE_TREK_RANGE warning state behind BOTH admin shells (the desktop
 * panel and the phone panel render their own dialog/sheet over it). `guard` parks a
 * registry install behind the confirm step when the entry was already flagged
 * incompatible; `notice` shows the after-the-fact warning for a response that carries the
 * server's marker. Whether the switch is ON stays a plain `useState` in each shell: its
 * setter is read inside the mount-time refresh, and only a useState setter is something
 * the exhaustive-deps rule knows to be stable.
 */
export function useRangeBypass() {
  const { t } = useTranslation()
  const [warning, setWarning] = useState<RangeWarning | null>(null)

  const notice = (name: string, b: TrekRangeBypass | null | undefined) => {
    if (b) setWarning({ name, trekRange: b.trekRange, hostVersion: b.hostVersion, onConfirm: null })
  }
  const guard = (warn: RangeWarning | undefined, run: () => void) => {
    if (warn) setWarning({ ...warn, onConfirm: run })
    else run()
  }
  const confirm = () => { const w = warning; setWarning(null); w?.onConfirm?.() }
  const dismiss = () => setWarning(null)

  return {
    warning,
    copy: warning ? rangeWarningCopy(warning, t) : null,
    notice, guard, confirm, dismiss,
  }
}
