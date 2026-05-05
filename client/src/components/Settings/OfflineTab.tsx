/**
 * Offline settings tab — shows cached trips, storage info, and controls
 * to re-sync or clear the offline cache. Also exposes runtime SW cache config.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Wifi, RefreshCw, Trash2, Database, Settings2, RotateCcw, CheckCircle } from 'lucide-react'
import Section from './Section'
import { offlineDb, clearAll } from '../../db/offlineDb'
import { tripSyncManager } from '../../sync/tripSyncManager'
import { mutationQueue } from '../../sync/mutationQueue'
import {
  DEFAULT_SW_CONFIG,
  loadSwConfig,
  saveSwConfig,
  validateSwConfig,
  SW_CONFIG_BOUNDS,
  type SwCacheConfig,
} from '../../sync/swConfig'
import type { SyncMeta } from '../../db/offlineDb'
import type { Trip } from '../../types'

interface CachedTripRow {
  trip: Trip
  meta: SyncMeta
  placeCount: number
  fileCount: number
}

export default function OfflineTab(): React.ReactElement {
  const [rows, setRows] = useState<CachedTripRow[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [loading, setLoading] = useState(true)

  // Cache config state
  const [cacheConfig, setCacheConfig] = useState<SwCacheConfig>({ ...DEFAULT_SW_CONFIG })
  const [configSaving, setConfigSaving] = useState(false)
  const [configApplied, setConfigApplied] = useState<Date | null>(null)
  const appliedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [metas, pending] = await Promise.all([
        offlineDb.syncMeta.toArray(),
        mutationQueue.pendingCount(),
      ])
      setPendingCount(pending)

      const result: CachedTripRow[] = []
      for (const meta of metas) {
        const trip = await offlineDb.trips.get(meta.tripId)
        if (!trip) continue
        const [placeCount, fileCount] = await Promise.all([
          offlineDb.places.where('trip_id').equals(meta.tripId).count(),
          offlineDb.tripFiles.where('trip_id').equals(meta.tripId).count(),
        ])
        result.push({ trip, meta, placeCount, fileCount })
      }
      result.sort((a, b) => (a.trip.start_date ?? '').localeCompare(b.trip.start_date ?? ''))
      setRows(result)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Load persisted cache config on mount
  useEffect(() => {
    loadSwConfig().then(setCacheConfig).catch(() => {})
  }, [])

  // Listen for SW acknowledgement
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'CACHE_CONFIG_APPLIED') {
        setConfigApplied(new Date())
        setConfigSaving(false)
        if (appliedTimerRef.current) clearTimeout(appliedTimerRef.current)
        appliedTimerRef.current = setTimeout(() => setConfigApplied(null), 5000)
      }
    }
    navigator.serviceWorker?.addEventListener('message', handler)
    return () => {
      navigator.serviceWorker?.removeEventListener('message', handler)
      if (appliedTimerRef.current) clearTimeout(appliedTimerRef.current)
    }
  }, [])

  async function handleSaveConfig() {
    const validated = validateSwConfig(cacheConfig)
    setCacheConfig(validated)
    setConfigSaving(true)
    try {
      await saveSwConfig(validated)
      const controller = navigator.serviceWorker?.controller
      if (controller) {
        controller.postMessage({ type: 'UPDATE_CACHE_CONFIG', config: validated })
        // configSaving cleared by the SW message handler
      } else {
        // No active SW yet (e.g. first install) — config saved to IDB, applied on next SW activation
        setConfigApplied(new Date())
        setConfigSaving(false)
      }
    } catch {
      setConfigSaving(false)
    }
  }

  function handleResetConfig() {
    setCacheConfig({ ...DEFAULT_SW_CONFIG })
  }

  function updateField(field: keyof SwCacheConfig) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = parseInt(e.target.value, 10)
      if (!isNaN(v)) setCacheConfig(prev => ({ ...prev, [field]: v }))
    }
  }

  async function handleResync() {
    setSyncing(true)
    try {
      const timeout = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 120_000))
      const result = await Promise.race([tripSyncManager.syncAll().then(() => 'done' as const), timeout])
      if (result === 'timeout') {
        tripSyncManager.interrupt()
        console.warn('[OfflineTab] sync timed out after 120 s')
      }
      await load()
    } finally {
      setSyncing(false)
    }
  }

  async function handleClear() {
    if (!window.confirm('Clear all offline trip data? You can re-sync anytime while online.')) return
    setClearing(true)
    try {
      await clearAll()
      await load()
    } finally {
      setClearing(false)
    }
  }

  const formatDate = (d: string | null | undefined) =>
    d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

  return (
    <Section title="Offline Cache" icon={Database}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Stats row */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Stat label="Cached trips" value={rows.length} />
          <Stat label="Pending changes" value={pendingCount} />
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleResync}
            disabled={syncing || !navigator.onLine}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
              borderRadius: 8, border: '1px solid var(--border-primary)',
              background: 'var(--bg-secondary)', color: 'var(--text-primary)',
              cursor: syncing || !navigator.onLine ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 500, opacity: !navigator.onLine ? 0.5 : 1,
            }}
          >
            <RefreshCw size={14} style={syncing ? { animation: 'spin 1s linear infinite' } : {}} />
            {syncing ? 'Syncing…' : 'Re-sync now'}
          </button>

          <button
            onClick={handleClear}
            disabled={clearing || rows.length === 0}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
              borderRadius: 8, border: '1px solid var(--border-primary)',
              background: 'var(--bg-secondary)', color: '#ef4444',
              cursor: clearing || rows.length === 0 ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 500, opacity: rows.length === 0 ? 0.5 : 1,
            }}
          >
            <Trash2 size={14} />
            Clear cache
          </button>
        </div>

        {/* Cache configuration */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Settings2 size={14} style={{ color: 'var(--text-muted)' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Cache configuration</span>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            Changes apply immediately to the service worker and persist across reloads.
            Existing cached entries follow their original TTL; new entries use the updated settings.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <CacheField
              label="API cache TTL (days)"
              value={cacheConfig.apiTtlDays}
              min={SW_CONFIG_BOUNDS.ttlMin}
              max={SW_CONFIG_BOUNDS.ttlMax}
              onChange={updateField('apiTtlDays')}
            />
            <CacheField
              label="API max entries"
              value={cacheConfig.apiMaxEntries}
              min={SW_CONFIG_BOUNDS.entriesMin}
              max={SW_CONFIG_BOUNDS.entriesMax}
              onChange={updateField('apiMaxEntries')}
            />
            <CacheField
              label="Map tiles TTL (days)"
              value={cacheConfig.tilesTtlDays}
              min={SW_CONFIG_BOUNDS.ttlMin}
              max={SW_CONFIG_BOUNDS.ttlMax}
              onChange={updateField('tilesTtlDays')}
            />
            <CacheField
              label="Map tiles max entries"
              value={cacheConfig.tilesMaxEntries}
              min={SW_CONFIG_BOUNDS.entriesMin}
              max={SW_CONFIG_BOUNDS.entriesMax}
              onChange={updateField('tilesMaxEntries')}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={handleSaveConfig}
              disabled={configSaving}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                borderRadius: 8, border: '1px solid var(--border-primary)',
                background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                cursor: configSaving ? 'not-allowed' : 'pointer',
                fontSize: 13, fontWeight: 500, opacity: configSaving ? 0.6 : 1,
              }}
            >
              <RefreshCw size={14} style={configSaving ? { animation: 'spin 1s linear infinite' } : {}} />
              {configSaving ? 'Applying…' : 'Save'}
            </button>
            <button
              onClick={handleResetConfig}
              disabled={configSaving}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                borderRadius: 8, border: '1px solid var(--border-primary)',
                background: 'var(--bg-secondary)', color: 'var(--text-muted)',
                cursor: configSaving ? 'not-allowed' : 'pointer',
                fontSize: 13, fontWeight: 500,
              }}
            >
              <RotateCcw size={14} />
              Reset to defaults
            </button>
            {configApplied && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#22c55e' }}>
                <CheckCircle size={12} />
                Applied at {configApplied.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
        </div>

        {/* Cached trip list */}
        {loading ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            No trips cached yet. Connect to internet to sync.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map(({ trip, meta, placeCount, fileCount }) => (
              <div
                key={trip.id}
                style={{
                  padding: '10px 14px', borderRadius: 8,
                  border: '1px solid var(--border-primary)',
                  background: 'var(--bg-secondary)',
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: trip.title ? 'var(--text-primary)' : 'var(--text-muted)', fontStyle: trip.title ? 'normal' : 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {trip.title || 'Unnamed trip'}
                    </span>
                    {trip.description ? (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {trip.description.length > 72 ? trip.description.slice(0, 72) + '…' : trip.description}
                      </span>
                    ) : null}
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {trip.start_date
                        ? `${formatDate(trip.start_date)} – ${formatDate(trip.end_date)}`
                        : 'No dates set'}
                      {' · '}
                      {placeCount} place{placeCount !== 1 ? 's' : ''}
                      {fileCount > 0 ? ` · ${fileCount} file${fileCount !== 1 ? 's' : ''}` : null}
                    </span>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                    <Wifi size={10} style={{ display: 'inline', marginRight: 3 }} />
                    {meta.lastSyncedAt
                      ? new Date(meta.lastSyncedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                      : '—'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{
      padding: '8px 14px', borderRadius: 8,
      border: '1px solid var(--border-primary)',
      background: 'var(--bg-secondary)', minWidth: 100,
    }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
    </div>
  )
}

function CacheField({
  label, value, min, max, onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={onChange}
        style={{
          padding: '6px 10px', borderRadius: 6,
          border: '1px solid var(--border-primary)',
          background: 'var(--bg-secondary)', color: 'var(--text-primary)',
          fontSize: 13, width: '100%', boxSizing: 'border-box',
        }}
      />
    </label>
  )
}
