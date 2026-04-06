import { Eye, EyeOff, X } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { ProviderImg } from './ProviderImg'
import type { TripPhoto } from '../types'

interface PhotoElementProps {
  photo: TripPhoto
  currentUserId?: number
  buildProviderAssetUrl: (photo: TripPhoto, what: string) => string
  onOpenLightbox: (photo: TripPhoto) => void
  onToggleSharing: (photo: TripPhoto, shared: boolean) => void
  onRemovePhoto: (photo: TripPhoto) => void
}

export function PhotoElement({
  photo,
  currentUserId,
  buildProviderAssetUrl,
  onOpenLightbox,
  onToggleSharing,
  onRemovePhoto,
}: PhotoElementProps) {
  const { t } = useTranslation()
  const isOwn = photo.user_id === currentUserId
  const usernameInitial = (photo.username?.[0] || '?').toUpperCase()

  return (
    <div
      className="group"
      style={{ position: 'relative', aspectRatio: '1', borderRadius: 10, overflow: 'visible', cursor: 'pointer' }}
      onClick={() => onOpenLightbox(photo)}
    >
      <ProviderImg
        baseUrl={buildProviderAssetUrl(photo, 'thumbnail')}
        loading="lazy"
        style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 10 }}
      />

      {!isOwn && (
        <div className="memories-avatar" style={{ position: 'absolute', bottom: 6, left: 6, zIndex: 10 }}>
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              background: `hsl(${usernameInitial.charCodeAt(0) * 37 % 360}, 55%, 55%)`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              fontWeight: 700,
              color: 'white',
              textTransform: 'uppercase',
              border: '2px solid white',
              boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
            }}
          >
            {usernameInitial}
          </div>
          <div
            className="memories-avatar-tooltip"
            style={{
              position: 'absolute',
              bottom: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              marginBottom: 6,
              padding: '3px 8px',
              borderRadius: 6,
              background: 'var(--text-primary)',
              color: 'var(--bg-primary)',
              fontSize: 10,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              opacity: 0,
              transition: 'opacity 0.15s',
            }}
          >
            {photo.username}
          </div>
        </div>
      )}

      {isOwn && (
        <div
          className="opacity-0 group-hover:opacity-100"
          style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 3, transition: 'opacity 0.15s' }}
        >
          <button
            onClick={e => {
              e.stopPropagation()
              onToggleSharing(photo, !photo.shared)
            }}
            title={photo.shared ? t('memories.stopSharing') : t('memories.sharePhotos')}
            style={{
              width: 26,
              height: 26,
              borderRadius: '50%',
              border: 'none',
              cursor: 'pointer',
              background: 'rgba(0,0,0,0.5)',
              backdropFilter: 'blur(4px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {photo.shared ? <Eye size={12} color="white" /> : <EyeOff size={12} color="white" />}
          </button>
          <button
            onClick={e => {
              e.stopPropagation()
              onRemovePhoto(photo)
            }}
            style={{
              width: 26,
              height: 26,
              borderRadius: '50%',
              border: 'none',
              cursor: 'pointer',
              background: 'rgba(0,0,0,0.5)',
              backdropFilter: 'blur(4px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <X size={12} color="white" />
          </button>
        </div>
      )}

      {isOwn && !photo.shared && (
        <div
          style={{
            position: 'absolute',
            bottom: 6,
            right: 6,
            padding: '2px 6px',
            borderRadius: 6,
            background: 'rgba(0,0,0,0.5)',
            backdropFilter: 'blur(4px)',
            fontSize: 9,
            color: 'rgba(255,255,255,0.7)',
            fontWeight: 500,
          }}
        >
          <EyeOff size={9} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 3 }} />
          {t('memories.private')}
        </div>
      )}
    </div>
  )
}
