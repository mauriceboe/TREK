import { useState, useEffect } from 'react'
import apiClient, { addonsApi } from '../../api/client'
import { Camera, Plus, X, ArrowUpDown, Link2, RefreshCw, FolderOpen } from 'lucide-react'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from '../../i18n'
import { clearImageQueue } from '../../api/authUrl'
import { useToast } from '../shared/Toast'
import { AlbumPickerModal } from './components/AlbumPickerModal'
import { PhotoPickerModal } from './components/PhotoPickerModal'
import { MemoriesLightbox } from './components/MemoriesLightbox'
import { PhotoElement } from './components/PhotoElement'
import { createMemoriesUrlBuilders } from './urlBuilders'
import { deriveVisibleMemories } from './selectors'
import type { PhotoProvider, TripPhoto, MemoriesPanelProps, AlbumLink } from './types'

// ── Main Component ──────────────────────────────────────────────────────────

export default function MemoriesPanel({ tripId, startDate, endDate }: MemoriesPanelProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const currentUser = useAuthStore(s => s.user)

  const [connected, setConnected] = useState(false)
  const [enabledProviders, setEnabledProviders] = useState<PhotoProvider[]>([])
  const [availableProviders, setAvailableProviders] = useState<PhotoProvider[]>([])
  const [selectedProvider, setSelectedProvider] = useState<string>('')
  const [loading, setLoading] = useState(true)

  // Trip photos (saved selections)
  const [tripPhotos, setTripPhotos] = useState<TripPhoto[]>([])

  // Photo picker
  const [showPicker, setShowPicker] = useState(false)

  // Filters & sort
  const [sortAsc, setSortAsc] = useState(true)
  const [locationFilter, setLocationFilter] = useState('')

  // Album linking
  const [showAlbumPicker, setShowAlbumPicker] = useState(false)
  const [albumLinks, setAlbumLinks] = useState<AlbumLink[]>([])
  const [syncing, setSyncing] = useState<number | null>(null)
  const { buildUnifiedUrl, buildProviderUrl, buildProviderAssetUrl } = createMemoriesUrlBuilders(tripId)

  const loadAlbumLinks = async (): Promise<AlbumLink[]> => {
    try {
      const res = await apiClient.get(buildUnifiedUrl('album-links'))
      const links = res.data.links || []
      setAlbumLinks(links)
      return links
    } catch {
      setAlbumLinks([])
      return []
    }
  }

  const openAlbumPicker = async () => {
    setShowAlbumPicker(true)
  }

  const unlinkAlbum = async (linkId: number) => {
    try {
      await apiClient.delete(buildUnifiedUrl('album-links', linkId.toString()))
      await loadAlbumLinks()
      await loadPhotos()
    } catch { toast.error(t('memories.error.unlinkAlbum')) }
  }

  const syncAlbum = async (linkId: number, provider?: string) => {
    const targetProvider = provider || selectedProvider
    if (!targetProvider) return
    setSyncing(linkId)
    try {
      await apiClient.post(buildProviderUrl(targetProvider, 'album-link-sync', linkId.toString()))
      await loadAlbumLinks()
      await loadPhotos()
    } catch { toast.error(t('memories.error.syncAlbum')) }
    finally { setSyncing(null) }
  }

  // Lightbox
  const [lightboxPhoto, setLightbox] = useState<TripPhoto | null>(null)

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
      const photosRes = await apiClient.get(buildUnifiedUrl('photos'))
      setTripPhotos(photosRes.data.photos || [])
    } catch {
      setTripPhotos([])
    }
  }

  const loadInitial = async () => {
    setLoading(true)
    try {
      const addonsRes = await addonsApi.enabled().catch(() => ({ addons: [] as any[] }))
      const enabledAddons = addonsRes?.addons || []
      const photoProviders = enabledAddons.filter((a: any) => a.type === 'photo_provider' && a.enabled)

      setEnabledProviders(photoProviders.map((a: any) => ({ id: a.id, name: a.name, icon: a.icon, config: a.config })))

      // Test connection status for each enabled provider
      const statusResults = await Promise.all(
        photoProviders.map(async (provider: any) => {
          const statusUrl = (provider.config as Record<string, unknown>)?.status_get as string
          if (!statusUrl) return { provider, connected: false }
          try {
            const res = await apiClient.get(statusUrl)
            return { provider, connected: !!res.data?.connected }
          } catch {
            return { provider, connected: false }
          }
        })
      )

      const connectedProviders = statusResults
        .filter(r => r.connected)
        .map(r => ({ id: r.provider.id, name: r.provider.name, icon: r.provider.icon, config: r.provider.config }))
      
      setAvailableProviders(connectedProviders)
      setConnected(connectedProviders.length > 0)
      if (connectedProviders.length > 0 && !selectedProvider) {
        setSelectedProvider(connectedProviders[0].id)
      }
    } catch {
      setAvailableProviders([])
      setConnected(false)
    } finally {
      await loadPhotos()
      await loadAlbumLinks()
      setLoading(false)
    }
  }

  // ── Photo Picker ──────────────────────────────────────────────────────────

  const [pickerDateFilter, setPickerDateFilter] = useState(true)

  const openPicker = () => {
    setShowPicker(true)
    setPickerDateFilter(!!(startDate && endDate))
  }

  const openLightbox = (photo: TripPhoto) => {
    setLightbox(photo)
  }


  // ── Remove photo ──────────────────────────────────────────────────────────

  const removePhoto = async (photo: TripPhoto) => {
    try {
      await apiClient.delete(buildUnifiedUrl('photos'), {
        data: {
          asset_id: photo.asset_id,
          provider: photo.provider,
        },
      })
      setTripPhotos(prev => prev.filter(p => !(p.provider === photo.provider && p.asset_id === photo.asset_id)))
    } catch { toast.error(t('memories.error.removePhoto')) }
  }

  // ── Toggle sharing ────────────────────────────────────────────────────────

  const toggleSharing = async (photo: TripPhoto, shared: boolean) => {
    try {
      await apiClient.put(buildUnifiedUrl('photos', 'sharing'), {
        shared,
        asset_id: photo.asset_id,
        provider: photo.provider,
      })
      setTripPhotos(prev => prev.map(p =>
        p.provider === photo.provider && p.asset_id === photo.asset_id ? { ...p, shared: shared ? 1 : 0 } : p
      ))
    } catch { toast.error(t('memories.error.toggleSharing')) }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  const { othersPhotos, allVisibleRaw, allVisible, locations } = deriveVisibleMemories({
    tripPhotos,
    currentUserId: currentUser?.id,
    locationFilter,
    sortAsc,
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
          {t('memories.notConnected', { provider_name: enabledProviders.length === 1 ? enabledProviders[0]?.name : 'Photo provider' })}
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', maxWidth: 300 }}>
          {enabledProviders.length === 1 ? t('memories.notConnectedHint', { provider_name: enabledProviders[0]?.name }) : t('memories.notConnectedMultipleHint', { provider_names: enabledProviders.map(p => p.name).join(', ') })}
        </p>
      </div>
    )
  }

  if (showAlbumPicker) {
    return (
      <div style={{ height: '100%', ...font }}>
        <AlbumPickerModal
          availableProviders={availableProviders}
          tripId={tripId}
          selectedProvider={selectedProvider}
          onSelectProvider={setSelectedProvider}
          albumLinks={albumLinks}
          onReloadAlbumLinks={loadAlbumLinks}
          onSyncAlbum={syncAlbum}
          onClose={() => { setShowAlbumPicker(false) }}
        />
      </div>
    )
  }

  if (showPicker) {
    return (
      <div style={{ height: '100%', ...font }}>
        <PhotoPickerModal
          availableProviders={availableProviders}
          selectedProvider={selectedProvider}
          onSelectProvider={setSelectedProvider}
          startDate={startDate}
          endDate={endDate}
          pickerDateFilter={pickerDateFilter}
          onSetPickerDateFilter={setPickerDateFilter}
          tripPhotos={tripPhotos}
          currentUserId={currentUser?.id}
          tripId={tripId}
          onAdded={async () => {
            setShowPicker(false)
            clearImageQueue()
            await loadInitial()
          }}
          onClose={() => setShowPicker(false)}
        />
      </div>
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
                <button onClick={() => syncAlbum(link.id, link.provider)} disabled={syncing === link.id} title={t('memories.syncAlbum')}
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
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
              {t('memories.noPhotos')}
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
            {allVisible.map(photo => (
              <PhotoElement
                key={`${photo.provider}:${photo.asset_id}`}
                photo={photo}
                currentUserId={currentUser?.id}
                buildProviderAssetUrl={buildProviderAssetUrl}
                onOpenLightbox={openLightbox}
                onToggleSharing={toggleSharing}
                onRemovePhoto={removePhoto}
              />
            ))}
          </div>
        )}
      </div>

      <style>{`
        .memories-avatar:hover .memories-avatar-tooltip { opacity: 1 !important; }
      `}</style>

      <MemoriesLightbox
        allVisible={allVisible}
        tripId={tripId}
        initialPhoto={lightboxPhoto}
        onClose={() => setLightbox(null)}
      />
    </div>
  )
}
