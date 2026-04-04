import { mapsApi } from '../api/client'

// Shared photo cache — used by PlaceAvatar (sidebar) and MapView (map markers)
interface PhotoEntry {
  photoUrl: string | null
  thumbDataUrl: string | null
}

const cache = new Map<string, PhotoEntry>()
const inFlight = new Set<string>()
const listeners = new Map<string, Set<(entry: PhotoEntry) => void>>()
// Separate thumb listeners — called when thumbDataUrl becomes available after initial load
const thumbListeners = new Map<string, Set<(thumb: string) => void>>()

function notify(key: string, entry: PhotoEntry) {
  listeners.get(key)?.forEach(fn => fn(entry))
  listeners.delete(key)
}

function notifyThumb(key: string, thumb: string) {
  thumbListeners.get(key)?.forEach(fn => fn(thumb))
  thumbListeners.delete(key)
}

export function onPhotoLoaded(key: string, fn: (entry: PhotoEntry) => void): () => void {
  if (!listeners.has(key)) listeners.set(key, new Set())
  listeners.get(key)!.add(fn)
  return () => { listeners.get(key)?.delete(fn) }
}

// Subscribe to thumb availability — called when base64 thumb is ready (may be after photoUrl)
export function onThumbReady(key: string, fn: (thumb: string) => void): () => void {
  if (!thumbListeners.has(key)) thumbListeners.set(key, new Set())
  thumbListeners.get(key)!.add(fn)
  return () => { thumbListeners.get(key)?.delete(fn) }
}

export function getCached(key: string): PhotoEntry | undefined {
  return cache.get(key)
}

export function isLoading(key: string): boolean {
  return inFlight.has(key)
}

// Convert image URL to base64 via canvas (CORS required — Wikimedia supports it)
export function urlToBase64(url: string, size: number = 48): Promise<string | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')!
        const s = Math.min(img.naturalWidth, img.naturalHeight)
        const sx = (img.naturalWidth - s) / 2
        const sy = (img.naturalHeight - s) / 2
        ctx.beginPath()
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
        ctx.clip()
        ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size)
        resolve(canvas.toDataURL('image/webp', 0.6))
      } catch { resolve(null) }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

export function fetchPhoto(
  cacheKey: string,
  photoId: string,
  lat?: number,
  lng?: number,
  name?: string,
  callback?: (entry: PhotoEntry) => void
) {
  const cached = cache.get(cacheKey)
  if (cached) { callback?.(cached); return }

  if (inFlight.has(cacheKey)) {
    if (callback) onPhotoLoaded(cacheKey, callback)
    return
  }

  inFlight.add(cacheKey)
  mapsApi.placePhoto(photoId, lat, lng, name)
    .then(async (data: { photoUrl?: string }) => {
      const photoUrl = data.photoUrl || null
      if (!photoUrl) {
        const entry: PhotoEntry = { photoUrl: null, thumbDataUrl: null }
        cache.set(cacheKey, entry)
        callback?.(entry)
        notify(cacheKey, entry)
        return
      }

      // Store URL first — sidebar can show immediately
      const entry: PhotoEntry = { photoUrl, thumbDataUrl: null }
      cache.set(cacheKey, entry)
      callback?.(entry)
      notify(cacheKey, entry)

      // Generate base64 thumb in background
      const thumb = await urlToBase64(photoUrl)
      if (thumb) {
        entry.thumbDataUrl = thumb
        notifyThumb(cacheKey, thumb)
      }
    })
    .catch(() => {
      const entry: PhotoEntry = { photoUrl: null, thumbDataUrl: null }
      cache.set(cacheKey, entry)
      callback?.(entry)
      notify(cacheKey, entry)
    })
    .finally(() => { inFlight.delete(cacheKey) })
}

export function getAllThumbs(): Record<string, string> {
  const r: Record<string, string> = {}
  for (const [k, v] of cache.entries()) {
    if (v.thumbDataUrl) r[k] = v.thumbDataUrl
  }
  return r
}
