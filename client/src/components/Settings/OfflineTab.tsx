/**
 * Offline settings tab (#1135) — controls for:
 *   - Offline mode: a force-offline switch that first downloads everything, then
 *     routes the app to the cache + mutation queue.
 *   - Prepare for offline: an awaited, progress-tracked full download.
 *   - What to store: a map-tiles toggle plus a per-trip on/off.
 *   - Sync conflicts: a keep-mine / keep-theirs resolver and a default strategy.
 *   - Cache stats + clear.
 *
 * All of the logic lives in `useOfflineSettings`, shared with the phone twin
 * `MSettingsOffline`; this file is the desktop markup over it.
 */
import React from 'react'
import { RefreshCw, Trash2, Database, CloudOff, Download, Check, GitMerge, Map as MapIcon, AlertTriangle } from 'lucide-react'
import Section from './Section'
import ToggleSwitch from './ToggleSwitch'
import { useOfflineSettings, offlineNoticeKey, isOfflineNoticeWarning } from './useOfflineSettings'
import { useTranslation } from '../../i18n'
import type { ConflictStrategy } from '../../sync/offlinePrefs'
import type { QueuedMutation } from '../../db/offlineDb'

function conflictName(m: QueuedMutation): string {
  const body = (m.body ?? {}) as { name?: unknown }
  const server = (m.conflictServer ?? {}) as { name?: unknown }
  return (typeof body.name === 'string' && body.name)
    || (typeof server.name === 'string' && server.name)
    || `#${m.entityId ?? ''}`
}

export default function OfflineTab(): React.ReactElement {
  const { t } = useTranslation()
  const {
    offline, forced,
    rows, allTrips, pendingCount, failedCount, conflicts,
    syncing, clearing, loading, preparing, progress, notice, prefs, canClear,
    runPrepare, handleToggleForce, handleResync, handleClear,
    handleToggleTiles, tripStorageState, handleToggleTrip, resolveConflict,
    handleConflictStrategy,
  } = useOfflineSettings()

  const formatDate = (d: string | null | undefined) =>
    d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

  const progressLabel = progress
    ? `${t(`settings.offline.prepare.phase.${progress.phase === 'done' ? 'trips' : progress.phase}`)} · ${progress.current}/${progress.total}`
    : ''

  return (
    <div>
      {/* Offline mode + prepare */}
      <Section title={t('settings.offline.mode.title')} icon={CloudOff}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Row
            label={t('settings.offline.mode.force')}
            hint={t('settings.offline.mode.forceHint')}
            control={<ToggleSwitch on={forced} onToggle={handleToggleForce} label={t('settings.offline.mode.force')} />}
          />
          {forced && (
            <p className="text-content-muted" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', margin: 0 }}>
              {t('settings.offline.mode.active')}
            </p>
          )}

          <div style={{ borderTop: '1px solid var(--border-secondary, #e5e7eb)', paddingTop: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 'calc(14px * var(--fs-scale-body, 1))', marginBottom: 4 }} className="text-content">
              {t('settings.offline.prepare.title')}
            </div>
            <p className="text-content-muted" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', marginTop: 0, marginBottom: 12 }}>
              {t('settings.offline.prepare.hint')}
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button"
                onClick={runPrepare}
                disabled={preparing || offline}
                className="border border-edge bg-surface-secondary text-content"
                style={btnStyle(preparing || offline)}
              >
                {preparing
                  ? <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  : <Download size={14} />}
                {preparing ? t('settings.offline.prepare.running') : t('settings.offline.prepare.button')}
              </button>
              <button type="button"
                onClick={handleResync}
                disabled={syncing || offline}
                className="border border-edge bg-surface-secondary text-content"
                style={btnStyle(syncing || offline)}
              >
                <RefreshCw size={14} style={syncing ? { animation: 'spin 1s linear infinite' } : {}} />
                {syncing ? t('settings.offline.resyncing') : t('settings.offline.resync')}
              </button>
            </div>
            {preparing && progress && (
              <div style={{ marginTop: 12 }}>
                <div style={{ height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--border-primary, #e5e7eb)' }}>
                  <div style={{
                    height: '100%', borderRadius: 3, background: 'var(--accent, #4F46E5)',
                    width: `${progress.total ? Math.round((progress.current / progress.total) * 100) : 100}%`,
                    transition: 'width 0.2s',
                  }} />
                </div>
                <div className="text-content-muted" style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', marginTop: 4 }}>
                  {progressLabel}{progress.label ? ` · ${progress.label}` : ''}
                </div>
              </div>
            )}
            {!preparing && notice && notice.kind !== 'load-failed' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'calc(12px * var(--fs-scale-body, 1))', marginTop: 10, color: isOfflineNoticeWarning(notice) ? 'var(--warning)' : 'var(--success)' }}>
                {isOfflineNoticeWarning(notice) ? <AlertTriangle size={14} /> : <Check size={14} />}
                {t(offlineNoticeKey(notice), notice.kind === 'stored' ? { count: notice.trips } : undefined)}
              </div>
            )}
          </div>
        </div>
      </Section>

      {/* Conflicts (only when there are any) */}
      {conflicts.length > 0 && (
        <Section title={t('settings.offline.conflicts.title')} icon={GitMerge}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p className="text-content-muted" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', margin: 0 }}>
              {t('settings.offline.conflicts.hint')}
            </p>
            {conflicts.map(c => (
              <div key={c.id} className="border border-edge bg-surface-secondary" style={{ padding: '10px 14px', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span className="text-content" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 500 }}>
                  {t('settings.offline.conflicts.item', { name: conflictName(c) })}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => resolveConflict(c.id, true)} className="border border-edge bg-surface-card text-content" style={smallBtnStyle()}>
                    {t('settings.offline.conflicts.keepMine')}
                  </button>
                  <button type="button" onClick={() => resolveConflict(c.id, false)} className="border border-edge bg-surface-card text-content" style={smallBtnStyle()}>
                    {t('settings.offline.conflicts.keepServer')}
                  </button>
                </div>
              </div>
            ))}
            <Row
              label={t('settings.offline.conflicts.strategyTitle')}
              control={
                <select
                  value={prefs.conflictStrategy}
                  onChange={e => handleConflictStrategy(e.target.value as ConflictStrategy)}
                  className="border border-edge bg-surface-secondary text-content"
                  style={{ padding: '6px 10px', borderRadius: 8, fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}
                >
                  <option value="ask">{t('settings.offline.conflicts.strategy.ask')}</option>
                  <option value="mine">{t('settings.offline.conflicts.strategy.mine')}</option>
                  <option value="server">{t('settings.offline.conflicts.strategy.server')}</option>
                </select>
              }
            />
          </div>
        </Section>
      )}

      {/* What to store offline */}
      <Section title={t('settings.offline.storage.title')} icon={MapIcon}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Row
            label={t('settings.offline.storage.tiles')}
            hint={t('settings.offline.storage.tilesHint')}
            control={<ToggleSwitch on={prefs.cacheTiles} onToggle={handleToggleTiles} label={t('settings.offline.storage.tiles')} />}
          />
          {allTrips.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border-secondary, #e5e7eb)', paddingTop: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 'calc(13px * var(--fs-scale-body, 1))', marginBottom: 8 }} className="text-content">
                {t('settings.offline.storage.tripsTitle')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {allTrips.map((trip) => {
                  const { on, dateEligible } = tripStorageState(trip)
                  return (
                    <div key={trip.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="text-content" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {trip.title}
                        </div>
                        <div className="text-content-muted" style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))' }}>
                          {on ? t('settings.offline.storage.tripOn') : t('settings.offline.storage.tripOff')}
                          {!dateEligible && ` · ${t('settings.offline.storage.tripFinished')}`}
                        </div>
                      </div>
                      <ToggleSwitch on={on} onToggle={() => handleToggleTrip(trip)} label={trip.title} />
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* Cache stats + list + clear */}
      <Section title={t('settings.offline.cache.title')} icon={Database}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Stat label={t('settings.offline.stats.trips')} value={rows.length} />
            <Stat label={t('settings.offline.stats.pending')} value={pendingCount} />
            {conflicts.length > 0 && <Stat label={t('settings.offline.stats.conflicts')} value={conflicts.length} danger />}
            {failedCount > 0 && <Stat label={t('settings.offline.stats.failed')} value={failedCount} danger />}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button"
              onClick={() => { if (window.confirm(t('settings.offline.clearConfirm'))) void handleClear() }}
              disabled={clearing || !canClear}
              className="border border-edge bg-surface-secondary text-[#ef4444]"
              style={btnStyle(clearing || !canClear)}
            >
              <Trash2 size={14} />
              {t('settings.offline.clear')}
            </button>
          </div>

          {loading ? (
            <p className="text-content-muted" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}>{t('settings.offline.loading')}</p>
          ) : rows.length === 0 ? (
            <p className="text-content-muted" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}>
              {t(notice?.kind === 'load-failed' ? 'settings.offline.notice.loadFailed' : 'settings.offline.empty')}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map(({ trip, meta, placeCount, fileCount }) => (
                <div
                  key={trip.id}
                  className="border border-edge bg-surface-secondary"
                  style={{ padding: '10px 14px', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 2 }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="text-content" style={{ fontWeight: 600, fontSize: 'calc(14px * var(--fs-scale-body, 1))' }}>
                      {trip.title}
                    </span>
                    <span className="text-content-muted" style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))' }}>
                      {meta.lastSyncedAt
                        ? new Date(meta.lastSyncedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                        : '—'}
                    </span>
                  </div>
                  <span className="text-content-muted" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))' }}>
                    {formatDate(trip.start_date)} – {formatDate(trip.end_date)}
                    {' · '}{placeCount}{' · '}{fileCount}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>
    </div>
  )
}

function btnStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 500, opacity: disabled ? 0.5 : 1,
  }
}

function smallBtnStyle(): React.CSSProperties {
  return {
    padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
    fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 500,
  }
}

function Row({ label, hint, control }: { label: string; hint?: string; control: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
      <div style={{ minWidth: 0 }}>
        <div className="text-content" style={{ fontWeight: 500, fontSize: 'calc(14px * var(--fs-scale-body, 1))' }}>{label}</div>
        {hint && <div className="text-content-muted" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', marginTop: 2 }}>{hint}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{control}</div>
    </div>
  )
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="border border-edge bg-surface-secondary" style={{ padding: '8px 14px', borderRadius: 8, minWidth: 100 }}>
      <div style={{ fontSize: 'calc(20px * var(--fs-scale-title, 1))', fontWeight: 700, color: danger ? '#ef4444' : undefined }}
        className={danger ? undefined : 'text-content'}>{value}</div>
      <div className="text-content-muted" style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))' }}>{label}</div>
    </div>
  )
}
