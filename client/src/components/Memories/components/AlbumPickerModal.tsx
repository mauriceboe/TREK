import { useEffect, useState } from 'react'
import apiClient from '../../../api/client'
import { Check, FolderOpen, Link2 } from 'lucide-react'
import { useToast } from '../../shared/Toast'
import { useTranslation } from '../../../i18n'
import { ProviderTabs } from './ProviderTabs'
import { createMemoriesUrlBuilders } from '../urlBuilders'
import type { Album, AlbumLink, PhotoProvider } from '../types'

interface AlbumPickerModalProps {
    availableProviders: PhotoProvider[]
    tripId: number
    selectedProvider: string
    onSelectProvider: (providerId: string) => void
    albumLinks: AlbumLink[]
    onReloadAlbumLinks: () => Promise<AlbumLink[]>
    onSyncAlbum: (linkId: number, provider?: string) => Promise<void>
    onClose: () => void
}

export function AlbumPickerModal({
    availableProviders,
    tripId,
    selectedProvider,
    onSelectProvider,
    albumLinks,
    onReloadAlbumLinks,
    onSyncAlbum,
    onClose,
}: AlbumPickerModalProps) {
    const { t } = useTranslation()
    const toast = useToast()
    const [albumsLoading, setAlbumsLoading] = useState(false)
    const [albums, setAlbums] = useState<Album[]>([])
    const { buildUnifiedUrl, buildProviderUrl } = createMemoriesUrlBuilders(tripId)

    useEffect(() => {
        let active = true

        const loadAlbums = async () => {
            if (!selectedProvider) {
                setAlbums([])
                return
            }

            setAlbumsLoading(true)
            try {
                const res = await apiClient.get(buildProviderUrl(selectedProvider, 'albums'))
                if (active) {
                    setAlbums(res.data.albums || [])
                }
            } catch {
                if (active) {
                    setAlbums([])
                }
            } finally {
                if (active) {
                    setAlbumsLoading(false)
                }
            }
        }

        loadAlbums()

        return () => {
            active = false
        }
    }, [selectedProvider, buildProviderUrl])

    const handleLinkAlbum = async (albumId: string, albumName: string) => {
        if (!selectedProvider) {
            toast.error(t('memories.error.linkAlbum'))
            return
        }

        try {
            await apiClient.post(buildUnifiedUrl('album-links'), {
                album_id: albumId,
                album_name: albumName,
                provider: selectedProvider,
            })

            const links = await onReloadAlbumLinks()

            onClose()

            const newLink = links.find((l: AlbumLink) => l.album_id === albumId && l.provider === selectedProvider)
            if (newLink) {
                await onSyncAlbum(newLink.id, selectedProvider)
            }
        } catch {
            toast.error(t('memories.error.linkAlbum'))
        }
    }

    const linkedIds = new Set(albumLinks.map(l => l.album_id))

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-secondary)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                        {availableProviders.length > 1
                            ? t('memories.selectAlbumMultiple')
                            : t('memories.selectAlbum', {
                                    provider_name: availableProviders.find(p => p.id === selectedProvider)?.name || 'Photo provider',
                                })}
                    </h3>
                    <button
                        onClick={onClose}
                        style={{
                            padding: '7px 14px',
                            borderRadius: 10,
                            border: '1px solid var(--border-primary)',
                            background: 'none',
                            fontSize: 12,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                            color: 'var(--text-muted)',
                        }}
                    >
                        {t('common.cancel')}
                    </button>
                </div>
                <ProviderTabs
                    availableProviders={availableProviders}
                    selectedProvider={selectedProvider}
                    onSelectProvider={onSelectProvider}
                />
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
                {albumsLoading ? (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                        <div
                            style={{
                                width: 24,
                                height: 24,
                                border: '2px solid var(--border-primary)',
                                borderTopColor: 'var(--text-primary)',
                                borderRadius: '50%',
                                animation: 'spin 0.8s linear infinite',
                                margin: '0 auto',
                            }}
                        />
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
                                <button
                                    key={album.id}
                                    onClick={() => !isLinked && handleLinkAlbum(album.id, album.albumName)}
                                    disabled={isLinked}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 12,
                                        width: '100%',
                                        padding: '12px 14px',
                                        borderRadius: 10,
                                        border: 'none',
                                        cursor: isLinked ? 'default' : 'pointer',
                                        background: isLinked ? 'var(--bg-tertiary)' : 'transparent',
                                        fontFamily: 'inherit',
                                        textAlign: 'left',
                                        opacity: isLinked ? 0.5 : 1,
                                    }}
                                    onMouseEnter={e => {
                                        if (!isLinked) e.currentTarget.style.background = 'var(--bg-hover)'
                                    }}
                                    onMouseLeave={e => {
                                        if (!isLinked) e.currentTarget.style.background = 'transparent'
                                    }}
                                >
                                    <FolderOpen size={20} color="var(--text-muted)" />
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{album.albumName}</div>
                                        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 1 }}>
                                            {album.assetCount} {t('memories.photos')}
                                        </div>
                                    </div>
                                    {isLinked ? <Check size={16} color="var(--text-faint)" /> : <Link2 size={16} color="var(--text-muted)" />}
                                </button>
                            )
                        })}
                    </div>
                )}
            </div>
        </div>
    )
}
