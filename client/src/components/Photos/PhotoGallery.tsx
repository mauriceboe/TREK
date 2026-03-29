import { useState, useMemo } from 'react'
import { PhotoLightbox } from './PhotoLightbox'
import { PhotoUpload } from './PhotoUpload'
import { Upload, Camera } from 'lucide-react'
import Modal from '../shared/Modal'
import { getLocaleForLanguage, useTranslation } from '../../i18n'
import type { Photo, Place, Day } from '../../types'

interface PhotoGalleryProps {
  photos: Photo[]
  onUpload: (fd: FormData) => Promise<void>
  onDelete: (photoId: number) => Promise<void>
  onUpdate: (photoId: number, data: Partial<Photo>) => Promise<void>
  places: Place[]
  days: Day[]
  tripId: number
}

export default function PhotoGallery({ photos, onUpload, onDelete, onUpdate, places, days, tripId }: PhotoGalleryProps) {
  const { t, language } = useTranslation()
  const [lightboxIndex, setLightboxIndex] = useState(null)
  const [showUpload, setShowUpload] = useState(false)
  const [filterDayId, setFilterDayId] = useState('')

  const filteredPhotos = useMemo(() => {
    return photos.filter(photo => {
      if (filterDayId && String(photo.day_id) !== String(filterDayId)) return false
      return true
    })
  }, [photos, filterDayId])

  const handlePhotoClick = (photo) => {
    const idx = filteredPhotos.findIndex(p => p.id === photo.id)
    setLightboxIndex(idx)
  }

  const handleDelete = async (photoId) => {
    await onDelete(photoId)
    if (lightboxIndex !== null) {
      const newPhotos = filteredPhotos.filter(p => p.id !== photoId)
      if (newPhotos.length === 0) {
        setLightboxIndex(null)
      } else if (lightboxIndex >= newPhotos.length) {
        setLightboxIndex(newPhotos.length - 1)
      }
    }
  }

  return (
    <div className="flex flex-col h-full" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ padding: '16px 24px', borderBottom: '1px solid rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, flexWrap: 'wrap' }}>
        <div style={{ marginRight: 'auto' }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>Fotos</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, color: '#9ca3af' }}>
            {photos.length} {photos.length !== 1 ? 'Fotos' : 'Foto'}
          </p>
        </div>

        <select
          value={filterDayId}
          onChange={e => setFilterDayId(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-slate-900"
        >
          <option value="">{t('photos.allDays')}</option>
          {(days || []).map(day => (
            <option key={day.id} value={day.id}>
              {t('planner.dayN', { n: day.day_number })}{day.date ? ` · ${formatDate(day.date, getLocaleForLanguage(language))}` : ''}
            </option>
          ))}
        </select>

        {filterDayId && (
          <button
            onClick={() => setFilterDayId('')}
            className="text-xs text-gray-500 hover:text-gray-700 underline"
          >
            {t('common.reset')}
          </button>
        )}

        <button
          onClick={() => setShowUpload(true)}
          className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded-lg hover:bg-slate-700 text-sm font-medium whitespace-nowrap"
        >
          <Upload className="w-4 h-4" />
          {t('common.upload')}
        </button>
      </div>

      {/* Gallery Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {filteredPhotos.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: '#9ca3af' }}>
            <Camera size={40} style={{ color: '#d1d5db', display: 'block', margin: '0 auto 12px' }} />
            <p style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 4px' }}>{t('photos.noPhotos')}</p>
            <p style={{ fontSize: 13, color: '#9ca3af', margin: '0 0 20px' }}>{t('photos.uploadHint')}</p>
            <button
              onClick={() => setShowUpload(true)}
              className="flex items-center gap-2 bg-slate-900 text-white px-6 py-3 rounded-xl hover:bg-slate-700 font-medium"
              style={{ display: 'inline-flex', margin: '0 auto' }}
            >
              <Upload className="w-4 h-4" />
              {t('common.upload')}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
            {filteredPhotos.map(photo => (
              <PhotoThumbnail
                key={photo.id}
                photo={photo}
                days={days}
                places={places}
                onClick={() => handlePhotoClick(photo)}
              />
            ))}

            {/* Upload tile */}
            <button
              onClick={() => setShowUpload(true)}
              className="aspect-square rounded-xl border-2 border-dashed border-gray-200 hover:border-slate-400 flex flex-col items-center justify-center gap-2 text-gray-400 hover:text-slate-700 transition-colors"
            >
              <Upload className="w-6 h-6" />
              <span className="text-xs">{t('common.add')}</span>
            </button>
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightboxIndex !== null && (
        <PhotoLightbox
          photos={filteredPhotos}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onUpdate={onUpdate}
          onDelete={handleDelete}
          days={days}
          places={places}
          tripId={tripId}
        />
      )}

      {/* Upload Modal */}
      <Modal
        isOpen={showUpload}
        onClose={() => setShowUpload(false)}
        title={t('common.upload')}
        size="lg"
      >
        <PhotoUpload
          tripId={tripId}
          days={days}
          places={places}
          onUpload={async (formData) => {
            await onUpload(formData)
            setShowUpload(false)
          }}
          onClose={() => setShowUpload(false)}
        />
      </Modal>
    </div>
  )
}

interface PhotoThumbnailProps {
  photo: Photo
  days: Day[]
  places: Place[]
  onClick: () => void
}

function PhotoThumbnail({ photo, days, places, onClick }: PhotoThumbnailProps) {
  const day = days?.find(d => d.id === photo.day_id)
  const place = places?.find(p => p.id === photo.place_id)

  return (
    <div
      className="aspect-square rounded-xl overflow-hidden cursor-pointer relative group bg-gray-100"
      onClick={onClick}
    >
      <img
        src={photo.url}
        alt={photo.caption || photo.original_name}
        className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
        loading="lazy"
        onError={e => {
          (e.target as HTMLImageElement).style.display = 'none'
          const next = (e.target as HTMLImageElement).nextSibling as HTMLElement; if (next) next.style.display = 'flex'
        }}
      />

      {/* Fallback */}
      <div className="hidden absolute inset-0 items-center justify-center text-gray-400 text-2xl">
        🖼️
      </div>

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all duration-200 flex flex-col justify-end p-2 opacity-0 group-hover:opacity-100">
        {photo.caption && (
          <p className="text-white text-xs font-medium truncate">{photo.caption}</p>
        )}
        {(day || place) && (
          <p className="text-white/70 text-xs truncate">
            {day ? `Tag ${day.day_number}` : ''}{day && place ? ' · ' : ''}{place?.name || ''}
          </p>
        )}
      </div>
    </div>
  )
}

function formatDate(dateStr, locale) {
  if (!dateStr) return ''
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short' })
}
