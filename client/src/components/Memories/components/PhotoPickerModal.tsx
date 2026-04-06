import { useEffect, useState } from 'react'
import apiClient from '../../../api/client'
import { Camera, Check } from 'lucide-react'
import { clearImageQueue } from '../../../api/authUrl'
import { useTranslation } from '../../../i18n'
import { useToast } from '../../shared/Toast'
import { ProviderImg } from './ProviderImg'
import { ConfirmShareModal } from './ConfirmShareModal'
import { PickerTemplate } from './PickerTemplate'
import { buildProviderAssetMemoriesUrl, buildProviderMemoriesUrl, createMemoriesUrlBuilders } from '../urlBuilders'
import type { Asset, PhotoProvider, TripPhoto } from '../types'

interface PhotoPickerModalProps {
  availableProviders: PhotoProvider[]
  selectedProvider: string
  onSelectProvider: (providerId: string) => void
  startDate: string | null
  endDate: string | null
  pickerDateFilter: boolean
  onSetPickerDateFilter: (useDateFilter: boolean) => void
  tripPhotos: TripPhoto[]
  currentUserId?: number
  tripId: number
  onAdded: () => Promise<void> | void
  onClose: () => void
}

export function PhotoPickerModal({
  availableProviders,
  selectedProvider,
  onSelectProvider,
  startDate,
  endDate,
  pickerDateFilter,
  onSetPickerDateFilter,
  tripPhotos,
  currentUserId,
  tripId,
  onAdded,
  onClose,
}: PhotoPickerModalProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerPhotos, setPickerPhotos] = useState<Asset[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showConfirmShare, setShowConfirmShare] = useState(false)
  const { buildUnifiedUrl } = createMemoriesUrlBuilders(tripId)

  useEffect(() => {
    let active = true

    const loadPickerPhotos = async () => {
      if (!selectedProvider) {
        if (active) {
          setPickerPhotos([])
          setPickerLoading(false)
        }
        return
      }

      setPickerLoading(true)
      try {
        const res = await apiClient.post(buildProviderMemoriesUrl(tripId, selectedProvider, 'search'), {
          from: pickerDateFilter && startDate ? startDate : undefined,
          to: pickerDateFilter && endDate ? endDate : undefined,
        })

        if (active) {
          setPickerPhotos((res.data.assets || []).map((asset: Asset) => ({ ...asset, provider: selectedProvider })))
        }
      } catch {
        if (active) {
          setPickerPhotos([])
          toast.error(t('memories.error.loadPhotos'))
        }
      } finally {
        if (active) {
          setPickerLoading(false)
        }
      }
    }

    loadPickerPhotos()

    return () => {
      active = false
    }
  }, [selectedProvider, pickerDateFilter, startDate, endDate, tripId, toast, t])

  const title = availableProviders.length > 1
    ? t('memories.selectPhotosMultiple')
    : t('memories.selectPhotos', {
        provider_name: availableProviders.find(p => p.id === selectedProvider)?.name || 'Photo provider',
      })

  const controls = (
    <>
      <div style={{ display: 'flex', gap: 6 }}>
        {startDate && endDate && (
          <button
            onClick={() => {
              if (!pickerDateFilter) {
                onSetPickerDateFilter(true)
              }
            }}
            style={{
              padding: '6px 14px',
              borderRadius: 99,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              border: '1px solid',
              transition: 'all 0.15s',
              background: pickerDateFilter ? 'var(--text-primary)' : 'var(--bg-card)',
              borderColor: pickerDateFilter ? 'var(--text-primary)' : 'var(--border-primary)',
              color: pickerDateFilter ? 'var(--bg-primary)' : 'var(--text-muted)',
            }}
          >
            {t('memories.tripDates')} ({startDate ? new Date(startDate + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''} - {endDate ? new Date(endDate + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''})
          </button>
        )}
        <button
          onClick={() => {
            if (pickerDateFilter || !startDate) {
              onSetPickerDateFilter(false)
            }
          }}
          style={{
            padding: '6px 14px',
            borderRadius: 99,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
            border: '1px solid',
            transition: 'all 0.15s',
            background: !pickerDateFilter ? 'var(--text-primary)' : 'var(--bg-card)',
            borderColor: !pickerDateFilter ? 'var(--text-primary)' : 'var(--border-primary)',
            color: !pickerDateFilter ? 'var(--bg-primary)' : 'var(--text-muted)',
          }}
        >
          {t('memories.allPhotos')}
        </button>
      </div>

      {selectedIds.size > 0 && (
        <p style={{ margin: '8px 0 0', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
          {selectedIds.size} {t('memories.selected')}
        </p>
      )}
    </>
  )

  // Helper functions
  const makePickerKey = (provider: string, assetId: string): string => `${provider}::${assetId}`

  const buildProviderAssetUrlFromAsset = (asset: Asset, what: string, userId: number): string => {
    const photo: TripPhoto = {
      asset_id: asset.id,
      provider: asset.provider,
      user_id: userId,
      username: '',
      shared: 0,
      added_at: null
    }
    return buildProviderAssetMemoriesUrl(tripId, photo, what)
  }
  const alreadyAdded = new Set(
    tripPhotos
      .filter(p => p.user_id === currentUserId)
      .map(p => makePickerKey(p.provider, p.asset_id))
  )

  const onTogglePickerSelect = (id: string) => {
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
      const groupedByProvider = new Map<string, string[]>()
      for (const key of selectedIds) {
        const [provider, assetId] = key.split('::')
        if (!provider || !assetId) continue
        const list = groupedByProvider.get(provider) || []
        list.push(assetId)
        groupedByProvider.set(provider, list)
      }

      await apiClient.post(buildUnifiedUrl('photos'), {
        selections: [...groupedByProvider.entries()].map(([provider, asset_ids]) => ({ provider, asset_ids })),
        shared: true,
      })
      setSelectedIds(new Set())
      await onAdded()
    } catch {
      toast.error(t('memories.error.addPhotos'))
    }
  }

  const primaryAction = (
    <button
      onClick={confirmSelection}
      disabled={selectedIds.size === 0}
      style={{
        padding: '7px 14px',
        borderRadius: 10,
        border: 'none',
        fontSize: 12,
        fontWeight: 600,
        cursor: selectedIds.size > 0 ? 'pointer' : 'default',
        fontFamily: 'inherit',
        background: selectedIds.size > 0 ? 'var(--text-primary)' : 'var(--border-primary)',
        color: selectedIds.size > 0 ? 'var(--bg-primary)' : 'var(--text-faint)',
      }}
    >
      {selectedIds.size > 0 ? t('memories.addSelected', { count: selectedIds.size }) : t('memories.addPhotos')}
    </button>
  )

  return (
    <>
      <PickerTemplate
        title={title}
        cancelLabel={t('common.cancel')}
        availableProviders={availableProviders}
        selectedProvider={selectedProvider}
        onSelectProvider={onSelectProvider}
        onClose={() => {
          clearImageQueue()
          onClose()
        }}
        primaryAction={primaryAction}
        controls={controls}
      >
          {pickerLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60 }}>
              <div
                className="w-7 h-7 border-2 rounded-full animate-spin"
                style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--text-primary)' }}
              />
            </div>
          ) : pickerPhotos.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px' }}>
              <Camera size={36} style={{ color: 'var(--text-faint)', margin: '0 auto 10px', display: 'block' }} />
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>{t('memories.noPhotos')}</p>
              {pickerDateFilter && (
                <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '0 0 16px' }}>
                  {t('memories.noPhotosHint', {
                    provider_name: availableProviders.find(p => p.id === selectedProvider)?.name || 'Photo provider',
                  })}
                </p>
              )}
            </div>
          ) : (
            (() => {
              const byMonth: Record<string, Asset[]> = {}
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
                      : '-'}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 4 }}>
                    {byMonth[month].map(asset => {
                      const pickerKey = makePickerKey(asset.provider, asset.id)
                      const isSelected = selectedIds.has(pickerKey)
                      const isAlready = alreadyAdded.has(pickerKey)

                      return (
                        <div
                          key={pickerKey}
                          onClick={() => !isAlready && onTogglePickerSelect(pickerKey)}
                          style={{
                            position: 'relative',
                            aspectRatio: '1',
                            borderRadius: 8,
                            overflow: 'hidden',
                            cursor: isAlready ? 'default' : 'pointer',
                            opacity: isAlready ? 0.3 : 1,
                            outline: isSelected ? '3px solid var(--text-primary)' : 'none',
                            outlineOffset: -3,
                          }}
                        >
                          <ProviderImg
                            baseUrl={buildProviderAssetUrlFromAsset(asset, 'thumbnail', currentUserId || 0)}
                            loading="lazy"
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                          {isSelected && (
                            <div
                              style={{
                                position: 'absolute',
                                top: 4,
                                right: 4,
                                width: 22,
                                height: 22,
                                borderRadius: '50%',
                                background: 'var(--text-primary)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <Check size={13} color="var(--bg-primary)" />
                            </div>
                          )}
                          {isAlready && (
                            <div
                              style={{
                                position: 'absolute',
                                inset: 0,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: 'rgba(0,0,0,0.3)',
                                fontSize: 10,
                                color: 'white',
                                fontWeight: 600,
                              }}
                            >
                              {t('memories.alreadyAdded')}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))
            })()
          )}
      </PickerTemplate>

      {showConfirmShare && (
        <ConfirmShareModal
          count={selectedIds.size}
          onCancel={() => setShowConfirmShare(false)}
          onConfirm={executeAddPhotos}
        />
      )}
    </>
  )
}
