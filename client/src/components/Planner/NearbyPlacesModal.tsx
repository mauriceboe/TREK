import { useState, useCallback } from 'react'
import Modal from '../shared/Modal'
import { mapsApi } from '../../api/client'
import { useTranslation } from '../../i18n'
import { MapPin, Star, Phone, ExternalLink, Plus, Loader2, ChevronLeft } from 'lucide-react'
import PlaceAvatar from '../shared/PlaceAvatar'

interface NearbyPlace {
  google_place_id: string | null
  osm_id: string | null
  name: string
  address: string
  lat: number | null
  lng: number | null
  rating: number | null
  website: string | null
  phone: string | null
  source: string
}

interface NearbyPlacesModalProps {
  isOpen: boolean
  onClose: () => void
  lat: number
  lng: number
  locationName: string
  onAddPlace: (data: Record<string, unknown>) => void
  enabledCategories?: string
  defaultRadius?: number
}

const ALL_TYPE_CATEGORIES = [
  { id: 'food', icon: '🍽️', color: '#f97316' },
  { id: 'attractions', icon: '🏛️', color: '#8b5cf6' },
  { id: 'shopping', icon: '🛍️', color: '#ec4899' },
  { id: 'nightlife', icon: '🌙', color: '#6366f1' },
  { id: 'outdoors', icon: '🌿', color: '#22c55e' },
  { id: 'transport', icon: '🚌', color: '#3b82f6' },
  { id: 'services', icon: '🏦', color: '#64748b' },
  { id: 'accommodation', icon: '🏨', color: '#0ea5e9' },
] as const

export default function NearbyPlacesModal({
  isOpen, onClose, lat, lng, locationName, onAddPlace,
  enabledCategories, defaultRadius = 1500,
}: NearbyPlacesModalProps) {
  const { t, language } = useTranslation()
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [places, setPlaces] = useState<NearbyPlace[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set())

  const enabledSet = enabledCategories
    ? new Set(enabledCategories.split(',').map(s => s.trim()).filter(Boolean))
    : null
  const visibleCategories = enabledSet
    ? ALL_TYPE_CATEGORIES.filter(c => enabledSet.has(c.id))
    : ALL_TYPE_CATEGORIES

  const [suggestedCategoryId, setSuggestedCategoryId] = useState<number | null>(null)

  const searchNearby = useCallback(async (type: string) => {
    setSelectedType(type)
    setLoading(true)
    setError(null)
    setPlaces([])
    setSuggestedCategoryId(null)
    try {
      const data = await mapsApi.nearby(lat, lng, type, defaultRadius, language)
      setPlaces(data.places || [])
      setSuggestedCategoryId(data.suggested_category_id || null)
      if (!data.places?.length) {
        setError(t('nearby.noResults'))
      }
    } catch {
      setError(t('nearby.searchError'))
    } finally {
      setLoading(false)
    }
  }, [lat, lng, language, t])

  const handleAdd = useCallback((place: NearbyPlace) => {
    const key = place.google_place_id || place.osm_id || `${place.lat},${place.lng}`
    onAddPlace({
      name: place.name,
      address: place.address,
      lat: place.lat,
      lng: place.lng,
      google_place_id: place.google_place_id || undefined,
      osm_id: place.osm_id || undefined,
      website: place.website || undefined,
      phone: place.phone || undefined,
      category_id: suggestedCategoryId || undefined,
    })
    setAddedIds(prev => new Set(prev).add(key))
  }, [onAddPlace])

  const handleBack = () => {
    setSelectedType(null)
    setPlaces([])
    setError(null)
  }

  const handleClose = () => {
    setSelectedType(null)
    setPlaces([])
    setError(null)
    setAddedIds(new Set())
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={
      selectedType ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={handleBack}
            style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 4, borderRadius: 6, color: 'var(--text-secondary)' }}
          >
            <ChevronLeft size={18} />
          </button>
          <span>{ALL_TYPE_CATEGORIES.find(c => c.id === selectedType)?.icon} {t(`nearby.types.${selectedType}`)}</span>
        </div>
      ) : t('nearby.title')
    } size="lg">
      {!selectedType ? (
        <div style={{ padding: '4px 0' }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
            <MapPin size={14} />
            <span>{t('nearby.searchingNear')} <strong>{locationName}</strong></span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {visibleCategories.map(cat => (
              <button
                key={cat.id}
                onClick={() => searchNearby(cat.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '14px 16px', borderRadius: 12,
                  background: 'var(--bg-hover)', border: '1px solid var(--border-faint)',
                  cursor: 'pointer', fontFamily: 'inherit',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.borderColor = cat.color
                  e.currentTarget.style.background = `${cat.color}10`
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = 'var(--border-faint)'
                  e.currentTarget.style.background = 'var(--bg-hover)'
                }}
              >
                <span style={{ fontSize: 22 }}>{cat.icon}</span>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {t(`nearby.types.${cat.id}`)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ minHeight: 200 }}>
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, gap: 8, color: 'var(--text-muted)' }}>
              <Loader2 size={18} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 13 }}>{t('nearby.searching')}</span>
            </div>
          )}

          {error && !loading && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 13 }}>
              {error}
            </div>
          )}

          {!loading && places.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: '60vh', overflowY: 'auto' }}>
              {places.map((place, i) => {
                const key = place.google_place_id || place.osm_id || `${place.lat},${place.lng}`
                const isAdded = addedIds.has(key)
                return (
                  <div
                    key={key || i}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '10px 12px', borderRadius: 10,
                      transition: 'background 0.12s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <PlaceAvatar place={{ id: i, name: place.name, image_url: null, google_place_id: place.google_place_id, osm_id: place.osm_id, lat: place.lat, lng: place.lng }} size={40} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {place.name}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                        {place.address}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                        {place.rating && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--text-secondary)' }}>
                            <Star size={10} fill="#facc15" color="#facc15" />
                            {place.rating.toFixed(1)}
                          </span>
                        )}
                        {place.phone && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--text-muted)' }}>
                            <Phone size={10} />
                          </span>
                        )}
                        {place.website && (
                          <a href={place.website} target="_blank" rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--text-muted)', textDecoration: 'none' }}>
                            <ExternalLink size={10} />
                          </a>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => !isAdded && handleAdd(place)}
                      disabled={isAdded}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        padding: '6px 12px', borderRadius: 8,
                        fontSize: 12, fontWeight: 500,
                        cursor: isAdded ? 'default' : 'pointer',
                        fontFamily: 'inherit',
                        border: 'none',
                        background: isAdded ? 'rgba(34,197,94,0.1)' : 'var(--accent)',
                        color: isAdded ? '#16a34a' : 'var(--accent-text)',
                        transition: 'all 0.15s',
                        flexShrink: 0,
                      }}
                    >
                      {isAdded ? (
                        <span>{t('nearby.added')}</span>
                      ) : (
                        <><Plus size={13} /> {t('nearby.add')}</>
                      )}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </Modal>
  )
}
