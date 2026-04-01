import { useState, useEffect, useCallback } from 'react'
import { Camera, Plus, Share2, EyeOff, Eye, X, Check, Search, ArrowUpDown, MapPin, Filter, Link2, RefreshCw, Unlink, FolderOpen } from 'lucide-react'
import apiClient from '../../api/client'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from '../../i18n'
import { getAuthUrl } from '../../api/authUrl'
import { useToast } from '../shared/Toast'

function ImmichImg({ baseUrl, style, loading }: { baseUrl: string; style?: React.CSSProperties; loading?: 'lazy' | 'eager' }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    getAuthUrl(baseUrl, 'immich').then(setSrc)
  }, [baseUrl])
  return src ? <img src={src} alt="" loading={loading} style={style} /> : null
}

// ── Types ───────────────────────────────────────────────────────────────────

interface TripPhoto {
  immich_asset_id: string
  user_id: number
  username: string
  shared: number
  added_at: string
}

interface ImmichAsset {
  id: string
  takenAt: string
  city: string | null
  country: string | null
}

interface MemoriesPanelProps {
  tripId: number
  startDate: string | null
  endDate: string | null
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function MemoriesPanel({ tripId, startDate, endDate }: MemoriesPanelProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const currentUser = useAuthStore(s => s.user)

  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)

  // Trip photos (saved selections)
  const [tripPhotos, setTripPhotos] = useState<TripPhoto[]>([])

  // Photo picker
  const [showPicker, setShowPicker] = useState(false)
  const [pickerPhotos, setPickerPhotos] = useState<ImmichAsset[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Confirm share popup
  const [showConfirmShare, setShowConfirmShare] = useState(false)

  // Filters & sort
  const [sortAsc, setSortAsc] = useState(true)
  const [locationFilter, setLocationFilter] = useState('')

  // Album linking
  const [showAlbumPicker, setShowAlbumPicker] = useState(false)
  const [albums, setAlbums] = useState<{ id: string; albumName: string; assetCount: number }[]>([])
  const [albumsLoading, setAlbumsLoading] = useState(false)
  const [albumLinks, setAlbumLinks] = useState<{ id: number; immich_album_id: string; album_name: string; user_id: number; username: string; sync_enabled: number; last_synced_at: string | null }[]>([])
  const [syncing, setSyncing] = useState<number | null>(null)

  const loadAlbumLinks = async () => {
    try {
      const res = await apiClient.get(`/integrations/immich/trips/${tripId}/album-links`)
      setAlbumLinks(res.data.links || [])
    } catch { setAlbumLinks([]) }
  }

  const openAlbumPicker = async () => {
    setShowAlbumPicker(true)
    setAlbumsLoading(true)
    try {
      const res = await apiClient.get('/integrations/immich/albums')
      setAlbums(res.data.albums || [])
    } catch { setAlbums([]); toast.error(t('memories.error.loadAlbums')) }
    finally { setAlbumsLoading(false) }
  }

  const linkAlbum = async (albumId: string, albumName: string) => {
    try {
      await apiClient.post(`/integrations/immich/trips/${tripId}/album-links`, { album_id: albumId, album_name: albumName })
      setShowAlbumPicker(false)
      await loadAlbumLinks()
      // Auto-sync after linking
      const linksRes = await apiClient.get(`/integrations/immich/trips/${tripId}/album-links`)
      const newLink = (linksRes.data.links || []).find((l: any) => l.immich_album_id === albumId)
      if (newLink) await syncAlbum(newLink.id)
    } catch { toast.error(t('memories.error.linkAlbum')) }
  }

  const unlinkAlbum = async (linkId: number) => {
    try {
      await apiClient.delete(`/integrations/immich/trips/${tripId}/album-links/${linkId}`)
      loadAlbumLinks()
    } catch { toast.error(t('memories.error.unlinkAlbum')) }
  }

  const syncAlbum = async (linkId: number) => {
    setSyncing(linkId)
    try {
      await apiClient.post(`/integrations/immich/trips/${tripId}/album-links/${linkId}/sync`)
      await loadAlbumLinks()
      await loadPhotos()
    } catch { toast.error(t('memories.error.syncAlbum')) }
    finally { setSyncing(null) }
  }

  // Lightbox
  const [lightboxId, setLightboxId] = useState<string | null>(null)
  const [lightboxUserId, setLightboxUserId] = useState<number | null>(null)
  const [lightboxInfo, setLightboxInfo] = useState<any>(null)
  const [lightboxInfoLoading, setLightboxInfoLoading] = useState(false)
  const [lightboxOriginalSrc, setLightboxOriginalSrc] = useState('')

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadInitial()
  }, [tripId])

  // WebSocket: reload photos when another user adds/removes/shares
  useEffect(() => {
    const handler = () => loadPhotos()
    window.addEventListener('memories:updated', handler)
    return () => window.removeEventListener('memories:updated', handler)
  }, [tripId])

  const loadPhotos = async () => {
    try {
      const photosRes = await apiClient.get(`/integrations/immich/trips/${tripId}/photos`)
      setTripPhotos(photosRes.data.photos || [])
    } catch {
      setTripPhotos([])
    }
  }

  const loadInitial = async () => {
    setLoading(true)
    try {
      const statusRes = await apiClient.get('/integrations/immich/status')
      setConnected(statusRes.data.connected)
    } catch {
      setConnected(false)
    }
    await loadPhotos()
    await loadAlbumLinks()
    setLoading(false)
  }

  // ── Photo Picker ──────────────────────────────────────────────────────────

  const [pickerDateFilter, setPickerDateFilter] = useState(true)

  const openPicker = async () => {
    setShowPicker(true)
    setPickerLoading(true)
    setSelectedIds(new Set())
    setPickerDateFilter(!!(startDate && endDate))
    await loadPickerPhotos(!!(startDate && endDate))
  }

  const loadPickerPhotos = async (useDate: boolean) => {
    setPickerLoading(true)
    try {
      const res = await apiClient.post('/integrations/immich/search', {
        from: useDate && startDate ? startDate : undefined,
        to: useDate && endDate ? endDate : undefined,
      })
      setPickerPhotos(res.data.assets || [])
    } catch {
      setPickerPhotos([])
      toast.error(t('memories.error.loadPhotos'))
    } finally {
      setPickerLoading(false)
    }
  }

  const togglePickerSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const confirmSelection = () => {
    if (selectedIds.size === 0) return
    setShowConfirmShare(true)
  }

  const executeAddPhotos = async () => {
    setShowConfirmShare(false)
    try {
      await apiClient.post(`/integrations/immich/trips/${tripId}/photos`, {
        asset_ids: [...selectedIds],
        shared: true,
      })
      setShowPicker(false)
      loadInitial()
    } catch { toast.error(t('memories.error.addPhotos')) }
  }

  // ── Remove photo ──────────────────────────────────────────────────────────

  const removePhoto = async (assetId: string) => {
    try {
      await apiClient.delete(`/integrations/immich/trips/${tripId}/photos/${assetId}`)
      setTripPhotos(prev => prev.filter(p => p.immich_asset_id !== assetId))
    } catch { toast.error(t('memories.error.removePhoto')) }
  }

  // ── Toggle sharing ────────────────────────────────────────────────────────

  const toggleSharing = async (assetId: string, shared: boolean) => {
    try {
      await apiClient.put(`/integrations/immich/trips/${tripId}/photos/${assetId}/sharing`, { shared })
      setTripPhotos(prev => prev.map(p =>
        p.immich_asset_id === assetId ? { ...p, shared: shared ? 1 : 0 } : p
      ))
    } catch { toast.error(t('memories.error.toggleSharing')) }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  const thumbnailBaseUrl = (assetId: string, userId: number) =>
    `/api/integrations/immich/assets/${assetId}/thumbnail?userId=${userId}`

  const ownPhotos = tripPhotos.filter(p => p.user_id === currentUser?.id)
  const othersPhotos = tripPhotos.filter(p => p.user_id !== currentUser?.id && p.shared)
  const allVisibleRaw = [...ownPhotos, ...othersPhotos]

  // Unique locations for filter
  const locations = [...new Set(allVisibleRaw.map(p => p.city).filter(Boolean) as string[])].sort()

  // Apply filter + sort
  const allVisible = allVisibleRaw
    .filter(p => !locationFilter || p.city === locationFilter)
    .sort((a, b) => {
      const da = new Date(a.added_at || 0).getTime()
      const db = new Date(b.added_at || 0).getTime()
      return sortAsc ? da - db : db - da
    })

  const font: React.CSSProperties = {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', ...font }}>
        <div className="w-8 h-8 border-2 rounded-full animate-spin"
          style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--text-primary)' }} />
      </div>
    )
  }

  // ── Not connected ─────────────────────────────────────────────────────────

  if (!connected && allVisible.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 40, textAlign: 'center', ...font }}>
        <Camera size={40} style={{ color: 'var(--text-faint)', marginBottom: 12 }} />
        <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
          {t('memories.notConnected')}
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', maxWidth: 300 }}>
          {t('memories.notConnectedHint')}
        </p>
      </div>
    )
  }

  // ── Photo Picker Modal ────────────────────────────────────────────────────

  // ── Album Picker Modal ──────────────────────────────────────────────────

  if (showAlbumPicker) {
    const linkedIds = new Set(albumLinks.map(l => l.immich_album_id))
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', ...font }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-secondary)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              {t('memories.selectAlbum')}
            </h3>
            <button onClick={() => setShowAlbumPicker(false)}
              style={{ padding: '7px 14px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {albumsLoading ? (
            <div style={{ textAlign: 'center', padding: 40 }}>
              <div style={{ width: 24, height: 24, border: '2px solid var(--border-primary)', borderTopColor: 'var(--text-primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto' }} />
            </div>
          ) : albums.length === 0 ? (
            <p style={{ textAlign: 'center', padding: 40, fontSize: 13, color: 'var(--text-faint)' }}>
              {t('memories.noAlbums')}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {albums.map(album => {
                const isLinked = linkedIds.has(album.id)
                return (
                  <button key={album.id} onClick={() => !isLinked && linkAlbum(album.id, album.albumName)}
                    disabled={isLinked}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 14px',
                      borderRadius: 10, border: 'none', cursor: isLinked ? 'default' : 'pointer',
                      background: isLinked ? 'var(--bg-tertiary)' : 'transparent', fontFamily: 'inherit', textAlign: 'left',
                      opacity: isLinked ? 0.5 : 1,
                    }}
                    onMouseEnter={e => { if (!isLinked) e.currentTarget.style.background = 'var(--bg-hover)' }}
                    onMouseLeave={e => { if (!isLinked) e.currentTarget.style.background = 'transparent' }}
                  >
                    <FolderOpen size={20} color="var(--text-muted)" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{album.albumName}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 1 }}>
                        {album.assetCount} {t('memories.photos')}
                      </div>
                    </div>
                    {isLinked ? (
                      <Check size={16} color="var(--text-faint)" />
                    ) : (
                      <Link2 size={16} color="var(--text-muted)" />
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Photo Picker Modal ────────────────────────────────────────────────────

  if (showPicker) {
    const alreadyAdded = new Set(tripPhotos.filter(p => p.user_id === currentUser?.id).map(p => p.immich_asset_id))

    return (
      <>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', ...font }}>
        {/* Picker header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-secondary)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              {t('memories.selectPhotos')}
            </h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setShowPicker(false)}
                style={{ padding: '7px 14px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
                {t('common.cancel')}
              </button>
              <button onClick={confirmSelection} disabled={selectedIds.size === 0}
                style={{
                  padding: '7px 14px', borderRadius: 10, border: 'none', fontSize: 12, fontWeight: 600,
                  cursor: selectedIds.size > 0 ? 'pointer' : 'default', fontFamily: 'inherit',
                  background: selectedIds.size > 0 ? 'var(--text-primary)' : 'var(--border-primary)',
                  color: selectedIds.size > 0 ? 'var(--bg-primary)' : 'var(--text-faint)',
                }}>
                {selectedIds.size > 0 ? t('memories.addSelected', { count: selectedIds.size }) : t('memories.addPhotos')}
              </button>
            </div>
          </div>
          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: 6 }}>
            {startDate && endDate && (
              <button onClick={() => { if (!pickerDateFilter) { setPickerDateFilter(true); loadPickerPhotos(true) } }}
                style={{
                  padding: '6px 14px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  border: '1px solid', transition: 'all 0.15s',
                  background: pickerDateFilter ? 'var(--text-primary)' : 'var(--bg-card)',
                  borderColor: pickerDateFilter ? 'var(--text-primary)' : 'var(--border-primary)',
                  color: pickerDateFilter ? 'var(--bg-primary)' : 'var(--text-muted)',
                }}>
                {t('memories.tripDates')} ({startDate ? new Date(startDate + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''} — {endDate ? new Date(endDate + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''})
              </button>
            )}
            <button onClick={() => { if (pickerDateFilter || !startDate) { setPickerDateFilter(false); loadPickerPhotos(false) } }}
              style={{
                padding: '6px 14px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                border: '1px solid', transition: 'all 0.15s',
                background: !pickerDateFilter ? 'var(--text-primary)' : 'var(--bg-card)',
                borderColor: !pickerDateFilter ? 'var(--text-primary)' : 'var(--border-primary)',
                color: !pickerDateFilter ? 'var(--bg-primary)' : 'var(--text-muted)',
              }}>
              {t('memories.allPhotos')}
            </button>
          </div>
          {selectedIds.size > 0 && (
            <p style={{ margin: '8px 0 0', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
              {selectedIds.size} {t('memories.selected')}
            </p>
          )}
        </div>

        {/* Picker grid */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {pickerLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60 }}>
              <div className="w-7 h-7 border-2 rounded-full animate-spin"
                style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--text-primary)' }} />
            </div>
          ) : pickerPhotos.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px' }}>
              <Camera size={36} style={{ color: 'var(--text-faint)', margin: '0 auto 10px', display: 'block' }} />
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>{t('memories.noPhotos')}</p>
            </div>
          ) : (() => {
            // Group photos by month
            const byMonth: Record<string, ImmichAsset[]> = {}
            for (const asset of pickerPhotos) {
              const d = asset.takenAt ? new Date(asset.takenAt) : null
              const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'unknown'
              if (!byMonth[key]) byMonth[key] = []
              byMonth[key].push(asset)
            }
            const sortedMonths = Object.keys(byMonth).sort().reverse()

            return sortedMonths.map(month => (
              <div key={month} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, paddingLeft: 2 }}>
                  {month !== 'unknown'
                    ? new Date(month + '-15').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
                    : '—'}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 4 }}>
                  {byMonth[month].map(asset => {
                    const isSelected = selectedIds.has(asset.id)
                    const isAlready = alreadyAdded.has(asset.id)
                    return (
                      <div key={asset.id}
                        onClick={() => !isAlready && togglePickerSelect(asset.id)}
                        style={{
                          position: 'relative', aspectRatio: '1', borderRadius: 8, overflow: 'hidden',
                          cursor: isAlready ? 'default' : 'pointer',
                          opacity: isAlready ? 0.3 : 1,
                          outline: isSelected ? '3px solid var(--text-primary)' : 'none',
                          outlineOffset: -3,
                        }}>
                        <ImmichImg baseUrl={thumbnailBaseUrl(asset.id, currentUser!.id)} loading="lazy"
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        {isSelected && (
                          <div style={{
                            position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: '50%',
                            background: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            <Check size={13} color="var(--bg-primary)" />
                          </div>
                        )}
                        {isAlready && (
                          <div style={{
                            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: 'rgba(0,0,0,0.3)', fontSize: 10, color: 'white', fontWeight: 600,
                          }}>
                            {t('memories.alreadyAdded')}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          })()}
        </div>
      </div>

      {/* Confirm share popup (inside picker) */}
      {showConfirmShare && (
        <div onClick={() => setShowConfirmShare(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--bg-card)', borderRadius: 16, padding: 24, maxWidth: 360, width: '100%', boxShadow: '0 16px 48px rgba(0,0,0,0.2)', textAlign: 'center' }}>
            <Share2 size={28} style={{ color: 'var(--text-primary)', marginBottom: 12 }} />
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              {t('memories.confirmShareTitle')}
            </h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {t('memories.confirmShareHint', { count: selectedIds.size })}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button onClick={() => setShowConfirmShare(false)}
                style={{ padding: '8px 20px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
                {t('common.cancel')}
              </button>
              <button onClick={executeAddPhotos}
                style={{ padding: '8px 20px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', background: 'var(--text-primary)', color: 'var(--bg-primary)' }}>
                {t('memories.confirmShareButton')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
    )
  }

  // ── Main Gallery ──────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', ...font }}>

      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-secondary)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
              {t('memories.title')}
            </h2>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
              {allVisible.length} {t('memories.photosFound')}
              {othersPhotos.length > 0 && ` · ${othersPhotos.length} ${t('memories.fromOthers')}`}
            </p>
          </div>
          {connected && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={openAlbumPicker}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 10,
                  border: '1px solid var(--border-primary)', background: 'none', color: 'var(--text-muted)',
                  fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                }}>
                <Link2 size={13} /> {t('memories.linkAlbum')}
              </button>
              <button onClick={openPicker}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 10,
                  border: 'none', background: 'var(--text-primary)', color: 'var(--bg-primary)',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                }}>
                <Plus size={14} /> {t('memories.addPhotos')}
              </button>
            </div>
          )}
        </div>

        {/* Linked Albums */}
        {albumLinks.length > 0 && (
          <div style={{ padding: '8px 20px', borderBottom: '1px solid var(--border-secondary)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {albumLinks.map(link => (
              <div key={link.id} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8,
                background: 'var(--bg-tertiary)', fontSize: 11, color: 'var(--text-muted)',
              }}>
                <FolderOpen size={11} />
                <span style={{ fontWeight: 500 }}>{link.album_name}</span>
                {link.username !== currentUser?.username && <span style={{ color: 'var(--text-faint)' }}>({link.username})</span>}
                <button onClick={() => syncAlbum(link.id)} disabled={syncing === link.id} title={t('memories.syncAlbum')}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', color: 'var(--text-faint)' }}>
                  <RefreshCw size={11} style={{ animation: syncing === link.id ? 'spin 1s linear infinite' : 'none' }} />
                </button>
                {link.user_id === currentUser?.id && (
                  <button onClick={() => unlinkAlbum(link.id)} title={t('memories.unlinkAlbum')}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', color: 'var(--text-faint)' }}>
                    <X size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Filter & Sort bar */}
      {allVisibleRaw.length > 0 && (
        <div style={{ display: 'flex', gap: 6, padding: '8px 20px', borderBottom: '1px solid var(--border-secondary)', flexShrink: 0, flexWrap: 'wrap' }}>
          <button onClick={() => setSortAsc(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 8,
              border: '1px solid var(--border-primary)', background: 'var(--bg-card)',
              fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)',
            }}>
            <ArrowUpDown size={11} /> {sortAsc ? t('memories.oldest') : t('memories.newest')}
          </button>
          {locations.length > 1 && (
            <select value={locationFilter} onChange={e => setLocationFilter(e.target.value)}
              style={{
                padding: '4px 10px', borderRadius: 8, border: '1px solid var(--border-primary)',
                background: 'var(--bg-card)', fontSize: 11, fontFamily: 'inherit', color: 'var(--text-muted)',
                cursor: 'pointer', outline: 'none',
              }}>
              <option value="">{t('memories.allLocations')}</option>
              {locations.map(loc => <option key={loc} value={loc}>{loc}</option>)}
            </select>
          )}
        </div>
      )}

      {/* Gallery */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {allVisible.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <Camera size={40} style={{ color: 'var(--text-faint)', margin: '0 auto 12px', display: 'block' }} />
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 4px' }}>
              {t('memories.noPhotos')}
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '0 0 16px' }}>
              {t('memories.noPhotosHint')}
            </p>
            <button onClick={openPicker}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, padding: '9px 18px', borderRadius: 10,
                border: 'none', background: 'var(--text-primary)', color: 'var(--bg-primary)',
                fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              }}>
              <Plus size={15} /> {t('memories.addPhotos')}
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 6 }}>
            {allVisible.map(photo => {
              const isOwn = photo.user_id === currentUser?.id
              return (
                <div key={photo.immich_asset_id} className="group"
                  style={{ position: 'relative', aspectRatio: '1', borderRadius: 10, overflow: 'visible', cursor: 'pointer' }}
                  onClick={() => {
                    setLightboxId(photo.immich_asset_id); setLightboxUserId(photo.user_id); setLightboxInfo(null)
                    setLightboxOriginalSrc('')
                    getAuthUrl(`/api/integrations/immich/assets/${photo.immich_asset_id}/original?userId=${photo.user_id}`, 'immich').then(setLightboxOriginalSrc)
                    setLightboxInfoLoading(true)
                    apiClient.get(`/integrations/immich/assets/${photo.immich_asset_id}/info?userId=${photo.user_id}`)
                      .then(r => setLightboxInfo(r.data)).catch(() => {}).finally(() => setLightboxInfoLoading(false))
                  }}>

                  <ImmichImg baseUrl={thumbnailBaseUrl(photo.immich_asset_id, photo.user_id)} loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 10 }} />

                  {/* Other user's avatar */}
                  {!isOwn && (
                    <div className="memories-avatar" style={{ position: 'absolute', bottom: 6, left: 6, zIndex: 10 }}>
                      <div style={{
                        width: 22, height: 22, borderRadius: '50%',
                        background: `hsl(${photo.username.charCodeAt(0) * 37 % 360}, 55%, 55%)`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: 700, color: 'white', textTransform: 'uppercase',
                        border: '2px solid white', boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                      }}>
                        {photo.username[0]}
                      </div>
                      <div className="memories-avatar-tooltip" style={{
                        position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
                        marginBottom: 6, padding: '3px 8px', borderRadius: 6,
                        background: 'var(--text-primary)', color: 'var(--bg-primary)',
                        fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
                        pointerEvents: 'none', opacity: 0, transition: 'opacity 0.15s',
                      }}>
                        {photo.username}
                      </div>
                    </div>
                  )}

                  {/* Own photo actions (hover) */}
                  {isOwn && (
                    <div className="opacity-0 group-hover:opacity-100"
                      style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 3, transition: 'opacity 0.15s' }}>
                      <button onClick={e => { e.stopPropagation(); toggleSharing(photo.immich_asset_id, !photo.shared) }}
                        title={photo.shared ? t('memories.stopSharing') : t('memories.sharePhotos')}
                        style={{
                          width: 26, height: 26, borderRadius: '50%', border: 'none', cursor: 'pointer',
                          background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                        {photo.shared ? <Eye size={12} color="white" /> : <EyeOff size={12} color="white" />}
                      </button>
                      <button onClick={e => { e.stopPropagation(); removePhoto(photo.immich_asset_id) }}
                        style={{
                          width: 26, height: 26, borderRadius: '50%', border: 'none', cursor: 'pointer',
                          background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                        <X size={12} color="white" />
                      </button>
                    </div>
                  )}

                  {/* Not shared indicator */}
                  {isOwn && !photo.shared && (
                    <div style={{
                      position: 'absolute', bottom: 6, right: 6, padding: '2px 6px', borderRadius: 6,
                      background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
                      fontSize: 9, color: 'rgba(255,255,255,0.7)', fontWeight: 500,
                    }}>
                      <EyeOff size={9} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 3 }} />
                      {t('memories.private')}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <style>{`
        .memories-avatar:hover .memories-avatar-tooltip { opacity: 1 !important; }
      `}</style>

      {/* Confirm share popup */}
      {showConfirmShare && (
        <div onClick={() => setShowConfirmShare(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--bg-card)', borderRadius: 16, padding: 24, maxWidth: 360, width: '100%', boxShadow: '0 16px 48px rgba(0,0,0,0.2)', textAlign: 'center' }}>
            <Share2 size={28} style={{ color: 'var(--text-primary)', marginBottom: 12 }} />
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              {t('memories.confirmShareTitle')}
            </h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {t('memories.confirmShareHint', { count: selectedIds.size })}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button onClick={() => setShowConfirmShare(false)}
                style={{ padding: '8px 20px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
                {t('common.cancel')}
              </button>
              <button onClick={executeAddPhotos}
                style={{ padding: '8px 20px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', background: 'var(--text-primary)', color: 'var(--bg-primary)' }}>
                {t('memories.confirmShareButton')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightboxId && lightboxUserId && (
        <div onClick={() => { setLightboxId(null); setLightboxUserId(null) }}
          style={{
            position: 'absolute', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
          <button onClick={() => { setLightboxId(null); setLightboxUserId(null) }}
            style={{
              position: 'absolute', top: 16, right: 16, width: 40, height: 40, borderRadius: '50%',
              background: 'rgba(255,255,255,0.1)', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
            <X size={20} color="white" />
          </button>
          <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', justifyContent: 'center', padding: 20, width: '100%', height: '100%' }}>
            <img
              src={lightboxOriginalSrc}
              alt=""
              style={{ maxWidth: lightboxInfo ? 'calc(100% - 280px)' : '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 10, cursor: 'default' }}
            />

            {/* Info panel — liquid glass */}
            {lightboxInfo && (
              <div style={{
                width: 240, flexShrink: 0, borderRadius: 16, padding: 18,
                background: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid rgba(255,255,255,0.12)', color: 'white',
                display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '100%', overflowY: 'auto',
              }}>
                {/* Date */}
                {lightboxInfo.takenAt && (
                  <div>
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.4)', marginBottom: 3 }}>Date</div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{new Date(lightboxInfo.takenAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{new Date(lightboxInfo.takenAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div>
                  </div>
                )}

                {/* Location */}
                {(lightboxInfo.city || lightboxInfo.country) && (
                  <div>
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.4)', marginBottom: 3 }}>
                      <MapPin size={9} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 3 }} />Location
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {[lightboxInfo.city, lightboxInfo.state, lightboxInfo.country].filter(Boolean).join(', ')}
                    </div>
                  </div>
                )}

                {/* Camera */}
                {lightboxInfo.camera && (
                  <div>
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.4)', marginBottom: 3 }}>Camera</div>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>{lightboxInfo.camera}</div>
                    {lightboxInfo.lens && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{lightboxInfo.lens}</div>}
                  </div>
                )}

                {/* Settings */}
                {(lightboxInfo.focalLength || lightboxInfo.aperture || lightboxInfo.iso) && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {lightboxInfo.focalLength && (
                      <div>
                        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Focal</div>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{lightboxInfo.focalLength}</div>
                      </div>
                    )}
                    {lightboxInfo.aperture && (
                      <div>
                        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Aperture</div>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{lightboxInfo.aperture}</div>
                      </div>
                    )}
                    {lightboxInfo.shutter && (
                      <div>
                        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Shutter</div>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{lightboxInfo.shutter}</div>
                      </div>
                    )}
                    {lightboxInfo.iso && (
                      <div>
                        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>ISO</div>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{lightboxInfo.iso}</div>
                      </div>
                    )}
                  </div>
                )}

                {/* Resolution & File */}
                {(lightboxInfo.width || lightboxInfo.fileName) && (
                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 10 }}>
                    {lightboxInfo.width && lightboxInfo.height && (
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 3 }}>{lightboxInfo.width} × {lightboxInfo.height}</div>
                    )}
                    {lightboxInfo.fileSize && (
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{(lightboxInfo.fileSize / 1024 / 1024).toFixed(1)} MB</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {lightboxInfoLoading && (
              <div style={{ width: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'rgba(255,255,255,0.2)', borderTopColor: 'white' }} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
