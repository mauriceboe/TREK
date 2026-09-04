/**
 * Offline settings section (#1135) — mobile-native twin of
 * components/Settings/OfflineTab. Same logic (force-offline switch, prepare /
 * resync, conflict resolver, per-trip storage, cache stats + clear), rebuilt on
 * the MSet* card system with MToggle switches and an MConfirmSheet for clear.
 *
 * The logic itself lives in the shared `useOfflineSettings` hook; only the
 * markup differs between the two shells.
 */
import { useState } from 'react'
import { RefreshCw, Trash2, Database, CloudOff, Download, Check, GitMerge, Map as MapIcon, AlertTriangle } from 'lucide-react'
import { useOfflineSettings, offlineNoticeKey, isOfflineNoticeWarning } from '../../../components/Settings/useOfflineSettings'
import { useTranslation } from '../../../i18n'
import type { ConflictStrategy } from '../../../sync/offlinePrefs'
import type { QueuedMutation } from '../../../db/offlineDb'
import { MSetCard, MSetEyebrow, MSetRow, MSetSegments, MSetButton } from './MSettingsUi'
import MToggle from '../../components/MToggle'
import MConfirmSheet from './MConfirmSheet'

function conflictName(m: QueuedMutation): string {
  const body = (m.body ?? {}) as { name?: unknown }
  const server = (m.conflictServer ?? {}) as { name?: unknown }
  return (typeof body.name === 'string' && body.name)
    || (typeof server.name === 'string' && server.name)
    || `#${m.entityId ?? ''}`
}

export default function MSettingsOffline() {
  const { t } = useTranslation()
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const {
    offline, forced,
    rows, allTrips, pendingCount, failedCount, conflicts,
    syncing, clearing, loading, preparing, progress, notice, prefs, canClear,
    runPrepare, handleToggleForce, handleResync, handleClear,
    handleToggleTiles, tripStorageState, handleToggleTrip, resolveConflict,
    handleConflictStrategy,
  } = useOfflineSettings()

  async function doClear() {
    await handleClear()
    setShowClearConfirm(false)
  }

  const formatDate = (d: string | null | undefined) =>
    d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

  const progressLabel = progress
    ? `${t(`settings.offline.prepare.phase.${progress.phase === 'done' ? 'trips' : progress.phase}`)} · ${progress.current}/${progress.total}`
    : ''

  const strategyOptions: { value: ConflictStrategy; label: string }[] = [
    { value: 'ask', label: t('settings.offline.conflicts.strategy.ask') },
    { value: 'mine', label: t('settings.offline.conflicts.strategy.mine') },
    { value: 'server', label: t('settings.offline.conflicts.strategy.server') },
  ]

  return (
    <>
      {/* Offline mode + prepare */}
      <MSetCard title={t('settings.offline.mode.title')} icon={CloudOff}>
        <div className="-mt-[4px]">
          <MSetRow
            first
            label={t('settings.offline.mode.force')}
            sub={t('settings.offline.mode.forceHint')}
            trailing={<MToggle checked={forced} onChange={handleToggleForce} ariaLabel={t('settings.offline.mode.force')} />}
          />
        </div>
        {forced && (
          <p className="mt-[2px] font-geist text-[0.6875rem] leading-relaxed text-m-muted">
            {t('settings.offline.mode.active')}
          </p>
        )}

        <div className="mt-3 border-t border-[color:var(--m-rowbr)] pt-3">
          <div className="text-[0.78125rem] font-bold text-m-ink">{t('settings.offline.prepare.title')}</div>
          <p className="mb-3 mt-[2px] font-geist text-[0.625rem] leading-relaxed text-m-muted">
            {t('settings.offline.prepare.hint')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <MSetButton variant="ghost" disabled={preparing || offline} onClick={runPrepare}>
              {preparing ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
              {preparing ? t('settings.offline.prepare.running') : t('settings.offline.prepare.button')}
            </MSetButton>
            <MSetButton variant="ghost" disabled={syncing || offline} onClick={handleResync}>
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
              {syncing ? t('settings.offline.resyncing') : t('settings.offline.resync')}
            </MSetButton>
          </div>
          {preparing && progress && (
            <div className="mt-3">
              <div className="h-[6px] overflow-hidden rounded-full bg-[color:var(--m-ic)]">
                <div
                  className="h-full rounded-full bg-m-act transition-[width] duration-200"
                  style={{ width: `${progress.total ? Math.round((progress.current / progress.total) * 100) : 100}%` }}
                />
              </div>
              <div className="mt-1 font-geist text-[0.625rem] text-m-muted">
                {progressLabel}{progress.label ? ` · ${progress.label}` : ''}
              </div>
            </div>
          )}
          {!preparing && notice && notice.kind !== 'load-failed' && (
            <div className={`mt-[10px] flex items-center gap-[6px] font-geist text-[0.6875rem] ${isOfflineNoticeWarning(notice) ? 'text-[color:var(--m-st-pending)]' : 'text-[color:var(--m-st-confirmed)]'}`}>
              {isOfflineNoticeWarning(notice) ? <AlertTriangle size={14} /> : <Check size={14} />}
              {t(offlineNoticeKey(notice), notice.kind === 'stored' ? { count: notice.trips } : undefined)}
            </div>
          )}
        </div>
      </MSetCard>

      {/* Conflicts (only when there are any) */}
      {conflicts.length > 0 && (
        <MSetCard title={t('settings.offline.conflicts.title')} icon={GitMerge} className="mt-3">
          <p className="font-geist text-[0.71875rem] leading-relaxed text-m-muted">
            {t('settings.offline.conflicts.hint')}
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {conflicts.map(c => (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheet)] px-[13px] py-[10px]"
              >
                <span className="min-w-0 flex-1 text-[0.78125rem] font-semibold text-m-ink">
                  {t('settings.offline.conflicts.item', { name: conflictName(c) })}
                </span>
                <div className="flex flex-none gap-2">
                  <button
                    type="button"
                    onClick={() => resolveConflict(c.id, true)}
                    className="rounded-full border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-[5px] text-[0.6875rem] font-bold text-m-ink"
                  >
                    {t('settings.offline.conflicts.keepMine')}
                  </button>
                  <button
                    type="button"
                    onClick={() => resolveConflict(c.id, false)}
                    className="rounded-full border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-[5px] text-[0.6875rem] font-bold text-m-ink"
                  >
                    {t('settings.offline.conflicts.keepServer')}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3">
            <MSetEyebrow className="mb-[5px]">{t('settings.offline.conflicts.strategyTitle')}</MSetEyebrow>
            <MSetSegments<ConflictStrategy>
              value={prefs.conflictStrategy}
              onChange={handleConflictStrategy}
              options={strategyOptions}
            />
          </div>
        </MSetCard>
      )}

      {/* What to store offline */}
      <MSetCard title={t('settings.offline.storage.title')} icon={MapIcon} className="mt-3">
        <div className="-mt-[4px]">
          <MSetRow
            first
            label={t('settings.offline.storage.tiles')}
            sub={t('settings.offline.storage.tilesHint')}
            trailing={<MToggle checked={prefs.cacheTiles} onChange={handleToggleTiles} ariaLabel={t('settings.offline.storage.tiles')} />}
          />
        </div>
        {allTrips.length > 0 && (
          <div className="mt-3 border-t border-[color:var(--m-rowbr)] pt-3">
            <div className="mb-1 text-[0.78125rem] font-bold text-m-ink">{t('settings.offline.storage.tripsTitle')}</div>
            <div>
              {allTrips.map((trip, i) => {
                const { on, dateEligible } = tripStorageState(trip)
                const sub = on ? t('settings.offline.storage.tripOn') : t('settings.offline.storage.tripOff')
                return (
                  <MSetRow
                    key={trip.id}
                    first={i === 0}
                    label={<span className="block truncate">{trip.title}</span>}
                    sub={dateEligible ? sub : `${sub} · ${t('settings.offline.storage.tripFinished')}`}
                    trailing={<MToggle checked={on} onChange={() => handleToggleTrip(trip)} ariaLabel={trip.title} />}
                  />
                )
              })}
            </div>
          </div>
        )}
      </MSetCard>

      {/* Cache stats + list + clear */}
      <MSetCard title={t('settings.offline.cache.title')} icon={Database} className="mt-3">
        <div className="flex flex-wrap gap-2">
          <MStat label={t('settings.offline.stats.trips')} value={rows.length} />
          <MStat label={t('settings.offline.stats.pending')} value={pendingCount} />
          {conflicts.length > 0 && <MStat label={t('settings.offline.stats.conflicts')} value={conflicts.length} danger />}
          {failedCount > 0 && <MStat label={t('settings.offline.stats.failed')} value={failedCount} danger />}
        </div>

        <div className="mt-3">
          <MSetButton variant="danger" disabled={clearing || !canClear} onClick={() => setShowClearConfirm(true)}>
            <Trash2 size={14} />
            {t('settings.offline.clear')}
          </MSetButton>
        </div>

        {loading ? (
          <p className="mt-3 font-geist text-[0.71875rem] text-m-muted">{t('settings.offline.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="mt-3 font-geist text-[0.71875rem] text-m-muted">
            {t(notice?.kind === 'load-failed' ? 'settings.offline.notice.loadFailed' : 'settings.offline.empty')}
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {rows.map(({ trip, meta, placeCount, fileCount }) => (
              <div
                key={trip.id}
                className="flex flex-col gap-[2px] rounded-[10px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheet)] px-[13px] py-[10px]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-bold text-m-ink">{trip.title}</span>
                  <span className="flex-none font-geist text-[0.625rem] text-m-faint">
                    {meta.lastSyncedAt
                      ? new Date(meta.lastSyncedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                      : '—'}
                  </span>
                </div>
                <span className="font-geist text-[0.6875rem] text-m-muted">
                  {formatDate(trip.start_date)} – {formatDate(trip.end_date)}
                  {' · '}{placeCount}{' · '}{fileCount}
                </span>
              </div>
            ))}
          </div>
        )}
      </MSetCard>

      <MConfirmSheet
        open={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        title={t('settings.offline.clear')}
        message={t('settings.offline.clearConfirm')}
        confirmLabel={t('settings.offline.clear')}
        cancelLabel={t('common.cancel')}
        danger
        busy={clearing}
        onConfirm={doClear}
      />
    </>
  )
}

function MStat({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="min-w-[92px] rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheet)] px-[13px] py-[9px]">
      <div className={`text-[1.125rem] font-extrabold tabular-nums ${danger ? 'text-[color:var(--m-st-danger)]' : 'text-m-ink'}`}>
        {value}
      </div>
      <div className="font-geist text-[0.5625rem] font-bold uppercase tracking-[.06em] text-m-faint">{label}</div>
    </div>
  )
}
