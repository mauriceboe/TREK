import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Info, MapPin, X } from 'lucide-react'
import apiClient from '../../../api/client'
import { fetchImageAsBlob } from '../../../api/authUrl'
import { buildProviderAssetMemoriesUrl } from '../urlBuilders'
import type { TripPhoto } from '../types'

interface MemoriesLightboxProps {
  allVisible: TripPhoto[]
  tripId: number
  initialPhoto: TripPhoto | null
  onClose: () => void
}

export function MemoriesLightbox({
  allVisible,
  tripId,
  initialPhoto,
  onClose,
}: MemoriesLightboxProps) {
  const touchStartX = useRef<number | null>(null)
  const [lightboxInfo, setLightboxInfo] = useState<any>(null)
  const [lightboxInfoLoading, setLightboxInfoLoading] = useState(false)
  const [lightboxOriginalSrc, setLightboxOriginalSrc] = useState('')
  const [showMobileInfo, setShowMobileInfo] = useState(false)
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768)
  const [currentPhoto, setCurrentPhoto] = useState<TripPhoto | null>(initialPhoto)

  useEffect(() => {
    setCurrentPhoto(initialPhoto)
  }, [initialPhoto])

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const currentIdx = currentPhoto
    ? allVisible.findIndex(p => p.provider === currentPhoto.provider && p.asset_id === currentPhoto.asset_id && p.user_id === currentPhoto.user_id)
    : -1
  const hasPrev = currentIdx > 0
  const hasNext = currentIdx < allVisible.length - 1

  useEffect(() => {
    if (!currentPhoto) return
    if (currentIdx < 0) {
      setCurrentPhoto(null)
      onClose()
    }
  }, [currentIdx, currentPhoto, onClose])

  useEffect(() => {
    if (!currentPhoto) return

    let revoked = ''
    let active = true

    setShowMobileInfo(false)
    setLightboxInfo(null)
    setLightboxInfoLoading(true)

    fetchImageAsBlob('/api' + buildProviderAssetMemoriesUrl(tripId, currentPhoto, 'original'))
      .then(blobUrl => {
        if (!active) {
          URL.revokeObjectURL(blobUrl)
          return
        }
        revoked = blobUrl
        setLightboxOriginalSrc(blobUrl)
      })
      .catch(() => {
        if (active) setLightboxOriginalSrc('')
      })

    apiClient.get(buildProviderAssetMemoriesUrl(tripId, currentPhoto, 'info'))
      .then(r => { if (active) setLightboxInfo(r.data) })
      .catch(() => { if (active) setLightboxInfo(null) })
      .finally(() => { if (active) setLightboxInfoLoading(false) })

    return () => {
      active = false
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [currentPhoto, tripId])

  if (!currentPhoto) return null

  const closeLightbox = () => {
    setCurrentPhoto(null)
    onClose()
  }

  const goPrev = () => {
    const photo = allVisible[currentIdx - 1]
    if (photo) setCurrentPhoto(photo)
  }

  const goNext = () => {
    const photo = allVisible[currentIdx + 1]
    if (photo) setCurrentPhoto(photo)
  }

  const exifContent = lightboxInfo ? (
    <>
      {lightboxInfo.takenAt && (
        <div>
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'rgba(255,255,255,0.4)',
              marginBottom: 3,
            }}
          >
            Date
          </div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {new Date(lightboxInfo.takenAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
            {new Date(lightboxInfo.takenAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      )}
      {(lightboxInfo.city || lightboxInfo.country) && (
        <div>
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'rgba(255,255,255,0.4)',
              marginBottom: 3,
            }}
          >
            <MapPin size={9} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 3 }} />
            Location
          </div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{[lightboxInfo.city, lightboxInfo.state, lightboxInfo.country].filter(Boolean).join(', ')}</div>
        </div>
      )}
      {lightboxInfo.camera && (
        <div>
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'rgba(255,255,255,0.4)',
              marginBottom: 3,
            }}
          >
            Camera
          </div>
          <div style={{ fontSize: 12, fontWeight: 500 }}>{lightboxInfo.camera}</div>
          {lightboxInfo.lens && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{lightboxInfo.lens}</div>}
        </div>
      )}
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
      {(lightboxInfo.width || lightboxInfo.fileName) && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 10 }}>
          {lightboxInfo.width && lightboxInfo.height && (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 3 }}>
              {lightboxInfo.width} x {lightboxInfo.height}
            </div>
          )}
          {lightboxInfo.fileSize && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{(lightboxInfo.fileSize / 1024 / 1024).toFixed(1)} MB</div>}
        </div>
      )}
    </>
  ) : null

  return (
    <div
      onClick={closeLightbox}
      onKeyDown={e => {
        if (e.key === 'ArrowLeft' && hasPrev) goPrev()
        if (e.key === 'ArrowRight' && hasNext) goNext()
        if (e.key === 'Escape') closeLightbox()
      }}
      tabIndex={0}
      ref={el => el?.focus()}
      onTouchStart={e => {
        touchStartX.current = e.touches[0].clientX
      }}
      onTouchEnd={e => {
        const start = touchStartX.current
        if (start == null) return
        const diff = e.changedTouches[0].clientX - start
        if (diff > 60 && hasPrev) goPrev()
        else if (diff < -60 && hasNext) goNext()
      }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 100,
        outline: 'none',
        background: 'rgba(0,0,0,0.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <button
        onClick={closeLightbox}
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          zIndex: 10,
          width: 40,
          height: 40,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.1)',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <X size={20} color="white" />
      </button>

      {allVisible.length > 1 && (
        <div style={{ position: 'absolute', top: 20, left: 20, zIndex: 10, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
          {currentIdx + 1} / {allVisible.length}
        </div>
      )}

      {hasPrev && (
        <button
          onClick={e => {
            e.stopPropagation()
            goPrev()
          }}
          style={{
            position: 'absolute',
            left: 12,
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 10,
            background: 'rgba(0,0,0,0.5)',
            border: 'none',
            borderRadius: '50%',
            width: 40,
            height: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: 'rgba(255,255,255,0.8)',
          }}
        >
          <ChevronLeft size={22} />
        </button>
      )}

      {hasNext && (
        <button
          onClick={e => {
            e.stopPropagation()
            goNext()
          }}
          style={{
            position: 'absolute',
            right: isMobile ? 12 : 280,
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 10,
            background: 'rgba(0,0,0,0.5)',
            border: 'none',
            borderRadius: '50%',
            width: 40,
            height: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: 'rgba(255,255,255,0.8)',
          }}
        >
          <ChevronRight size={22} />
        </button>
      )}

      {isMobile && (lightboxInfo || lightboxInfoLoading) && (
        <button
          onClick={e => {
            e.stopPropagation()
            setShowMobileInfo(prev => !prev)
          }}
          style={{
            position: 'absolute',
            top: 16,
            right: 68,
            zIndex: 10,
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: showMobileInfo ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Info size={20} color="white" />
        </button>
      )}

      <div
        onClick={e => {
          if (e.target === e.currentTarget) closeLightbox()
        }}
        style={{ display: 'flex', gap: 16, alignItems: 'flex-start', justifyContent: 'center', padding: 20, width: '100%', height: '100%' }}
      >
        <img
          src={lightboxOriginalSrc}
          alt=""
          onClick={e => e.stopPropagation()}
          style={{
            maxWidth: !isMobile && lightboxInfo ? 'calc(100% - 280px)' : '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            borderRadius: 10,
            cursor: 'default',
          }}
        />

        {!isMobile && lightboxInfo && (
          <div
            style={{
              width: 240,
              flexShrink: 0,
              borderRadius: 16,
              padding: 18,
              background: 'rgba(255,255,255,0.08)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: 'white',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              maxHeight: '100%',
              overflowY: 'auto',
            }}
          >
            {exifContent}
          </div>
        )}

        {!isMobile && lightboxInfoLoading && (
          <div style={{ width: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'rgba(255,255,255,0.2)', borderTopColor: 'white' }} />
          </div>
        )}
      </div>

      {isMobile && showMobileInfo && lightboxInfo && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 5,
            maxHeight: '60vh',
            overflowY: 'auto',
            borderRadius: '16px 16px 0 0',
            padding: 18,
            background: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderBottom: 'none',
            color: 'white',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {exifContent}
        </div>
      )}
    </div>
  )
}
