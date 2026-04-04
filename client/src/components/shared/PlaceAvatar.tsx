import React, { useState, useEffect, useRef } from 'react'
import { getCategoryIcon } from './categoryIcons'
import { getCached, isLoading, fetchPhoto, onThumbReady } from '../../services/photoService'
import type { Place } from '../../types'

interface Category {
  color?: string
  icon?: string
}

interface PlaceAvatarProps {
  place: Pick<Place, 'id' | 'name' | 'image_url' | 'google_place_id' | 'osm_id' | 'lat' | 'lng'>
  size?: number
  category?: Category | null
}

export default React.memo(function PlaceAvatar({ place, size = 32, category }: PlaceAvatarProps) {
  const [photoSrc, setPhotoSrc] = useState<string | null>(place.image_url || null)
  const [visible, setVisible] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Observe visibility — fetch photo only when avatar enters viewport
  useEffect(() => {
    if (place.image_url) { setVisible(true); return }
    const el = ref.current
    if (!el) return
    // Check if already cached — show immediately without waiting for intersection
    const photoId = place.google_place_id || place.osm_id
    const cacheKey = photoId || `${place.lat},${place.lng}`
    if (cacheKey && getCached(cacheKey)) { setVisible(true); return }

    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); io.disconnect() } }, { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [place.id])

  useEffect(() => {
    if (!visible) return
    if (place.image_url) { setPhotoSrc(place.image_url); return }
    const photoId = place.google_place_id || place.osm_id
    if (!photoId && !(place.lat && place.lng)) { setPhotoSrc(null); return }

    const cacheKey = photoId || `${place.lat},${place.lng}`

    const cached = getCached(cacheKey)
    if (cached) {
      setPhotoSrc(cached.thumbDataUrl || cached.photoUrl)
      if (!cached.thumbDataUrl && cached.photoUrl) {
        return onThumbReady(cacheKey, thumb => setPhotoSrc(thumb))
      }
      return
    }

    if (isLoading(cacheKey)) {
      return onThumbReady(cacheKey, thumb => setPhotoSrc(thumb))
    }

    fetchPhoto(cacheKey, photoId || `coords:${place.lat}:${place.lng}`, place.lat, place.lng, place.name,
      entry => { setPhotoSrc(entry.thumbDataUrl || entry.photoUrl) }
    )
    return onThumbReady(cacheKey, thumb => setPhotoSrc(thumb))
  }, [visible, place.id, place.image_url, place.google_place_id, place.osm_id])

  const bgColor = category?.color || '#6366f1'
  const IconComp = getCategoryIcon(category?.icon)
  const iconSize = Math.round(size * 0.46)

  const containerStyle: React.CSSProperties = {
    width: size, height: size,
    borderRadius: '50%',
    overflow: 'hidden',
    flexShrink: 0,
    backgroundColor: bgColor,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  }

  if (photoSrc) {
    return (
      <div ref={ref} style={containerStyle}>
        <img
          src={photoSrc}
          alt={place.name}
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setPhotoSrc(null)}
        />
      </div>
    )
  }

  return (
    <div ref={ref} style={containerStyle}>
      <IconComp size={iconSize} strokeWidth={1.8} color="rgba(255,255,255,0.92)" />
    </div>
  )
})
