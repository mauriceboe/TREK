import { useEffect, useRef, useImperativeHandle, useCallback, type Ref } from 'react'
import L from 'leaflet'
import { useSettingsStore } from '../../store/settingsStore'
import { useCartoApiKey } from '../../hooks/useTileUrl'
import { isVectorStyle, resolveTileUrl } from '../../utils/tileUrl'
import { OFM_DARK, OFM_POSITRON, attributionForTile } from '../../constants/mapDefaults'
import { attachVectorBasemap, type GlLeafletLayer } from '../Map/VectorBasemap'
import { escapeHtml, type JourneyTrack } from '@trek/shared'

export interface MapMarkerItem {
  id: string
  lat: number
  lng: number
  label: string
  mood?: string | null
  time: string
  dayColor: string
  dayLabel: number
}

/**
 * Grid clustering in screen space.
 *
 * The Journey maps have never had clustering, and the library the planner uses
 * hangs off react-leaflet while this map drives Leaflet directly. Bucketing by
 * rounded pixel position is a few lines, is deterministic, and is enough for the
 * job: photos of one place collapse into one thumbnail with a count, and pulling
 * the map apart separates them again.
 */
const PHOTO_CLUSTER_PX = 64

function clusterPhotos(
  map: L.Map,
  photos: MapPhoto[],
): { lat: number; lng: number; members: MapPhoto[] }[] {
  const buckets = new Map<string, MapPhoto[]>()
  for (const photo of photos) {
    const pt = map.latLngToContainerPoint([photo.lat, photo.lng])
    const key = `${Math.round(pt.x / PHOTO_CLUSTER_PX)}:${Math.round(pt.y / PHOTO_CLUSTER_PX)}`
    const list = buckets.get(key)
    if (list) list.push(photo)
    else buckets.set(key, [photo])
  }
  return [...buckets.values()].map(members => ({
    // Anchor on the first member rather than the centroid: the thumbnail shown is
    // that photo's, so the pin should point where that picture was taken.
    lat: members[0].lat,
    lng: members[0].lng,
    members,
  }))
}

function photoMarkerHtml(thumbUrl: string, count: number): string {
  const badge = count > 1
    ? `<span style="position:absolute;top:-6px;right:-6px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#fff;border:1.5px solid rgba(0,0,0,.12);box-shadow:0 1px 4px rgba(0,0,0,.22);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#111827;line-height:1;box-sizing:border-box;">${count}</span>`
    : ''
  return `<div style="position:relative;width:48px;height:48px;border-radius:12px;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.3);background-image:url('${encodeURI(thumbUrl)}');background-size:cover;background-position:center;"></div>${badge}`
}

export interface JourneyMapHandle {
  highlightMarker: (id: string | null) => void
  focusMarker: (id: string) => void
  invalidateSize: () => void
}

/** A photo that knows where it was taken (#1614). */
export interface MapPhoto {
  id: string
  lat: number
  lng: number
  thumbUrl: string
}

interface MapEntry {
  id: string
  lat: number
  lng: number
  title?: string | null
  mood?: string | null
  entry_date: string
  dayColor?: string
  dayLabel?: number
}

interface Props {
  ref?: Ref<JourneyMapHandle>
  checkins: any[]
  entries: MapEntry[]
  /** Photos placed by their own capture coordinates, clustered by proximity. */
  photos?: MapPhoto[]
  onPhotoClick?: (photoIds: string[]) => void
  trail?: { lat: number; lng: number }[]
  /** Routed GPX geometries from the journey's trips (#1260). */
  tracks?: JourneyTrack[]
  height?: number
  dark?: boolean
  activeMarkerId?: string | null
  onMarkerClick?: (id: string, type?: string) => void
  fullScreen?: boolean
  paddingBottom?: number
  /** CARTO key from the share payload: the public journey has no settings store to read. */
  cartoApiKey?: string
}

function buildMarkerItems(entries: MapEntry[]): MapMarkerItem[] {
  const items: MapMarkerItem[] = []
  for (const e of entries) {
    if (e.lat && e.lng) {
      items.push({
        id: e.id,
        lat: e.lat,
        lng: e.lng,
        label: e.title || 'Entry',
        mood: e.mood,
        time: e.entry_date,
        dayColor: e.dayColor || '#52525B',
        dayLabel: e.dayLabel ?? 1,
      })
    }
  }
  items.sort((a, b) => a.time.localeCompare(b.time))
  return items
}

const MARKER_W = 28
const MARKER_H = 36

function markerSvg(dayColor: string, dayLabel: number, highlighted: boolean): string {
  const stroke = highlighted ? '#fff' : 'rgba(255,255,255,0.5)'
  const shadow = highlighted
    ? 'filter:drop-shadow(0 0 10px rgba(0,0,0,0.4)) drop-shadow(0 2px 6px rgba(0,0,0,0.4))'
    : 'filter:drop-shadow(0 2px 4px rgba(0,0,0,0.25))'
  const label = String(dayLabel)
  const scale = highlighted ? 1.2 : 1

  return `<div style="transform:scale(${scale});transition:transform 0.2s ease;${shadow};transform-origin:bottom center">
    <svg width="${MARKER_W}" height="${MARKER_H}" viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 34C14 34 26 22.36 26 13C26 6.37 20.63 1 14 1C7.37 1 2 6.37 2 13C2 22.36 14 34 14 34Z" fill="${dayColor}" stroke="${stroke}" stroke-width="1.5"/>
      <circle cx="14" cy="13" r="8" fill="${dayColor}"/>
      <text x="14" y="13" text-anchor="middle" dominant-baseline="central" fill="#fff" font-family="'Poppins',system-ui,sans-serif" font-size="11" font-weight="700">${label}</text>
    </svg>
  </div>`
}

const EMPTY_TRAIL: { lat: number; lng: number }[] = []
const EMPTY_TRACKS: JourneyTrack[] = []
/** Fallback when a track carries no colour of its own, matching the planner's default. */
const TRACK_FALLBACK_COLOR = '#4f46e5'

function JourneyMap(
  { entries, photos, onPhotoClick, trail, tracks, height = 220, dark, activeMarkerId, onMarkerClick, fullScreen, paddingBottom, cartoApiKey, ref }: Props,
) {
  const stableTrail = trail || EMPTY_TRAIL
  const stableTracks = tracks || EMPTY_TRACKS
  const mapTileUrl = useSettingsStore(s => s.settings.map_tile_url)
  const storedCartoKey = useCartoApiKey()
  const cartoKey = cartoApiKey || storedCartoKey
  const tileUrl = resolveTileUrl(mapTileUrl, dark ? OFM_DARK : OFM_POSITRON, cartoKey)
  // Read through a ref by the map effect, retiled in place by its own effect below:
  // the CARTO key reaches the store after the first render, and rebuilding the map
  // for that raced with the markers and layers already on it (#2097).
  const tileUrlRef = useRef(tileUrl)
  tileUrlRef.current = tileUrl
  const tileLayerRef = useRef<L.TileLayer | null>(null)
  const glLayerRef = useRef<GlLeafletLayer | null>(null)
  // The vector basemap loads async; a map torn down before it lands must not get one.
  const cancelledRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<Map<string, L.Marker>>(new Map())
  const itemsRef = useRef<MapMarkerItem[]>([])
  const highlightedRef = useRef<string | null>(null)
  const onMarkerClickRef = useRef(onMarkerClick)
  onMarkerClickRef.current = onMarkerClick
  const photoLayerRef = useRef<L.LayerGroup | null>(null)
  const onPhotoClickRef = useRef(onPhotoClick)
  onPhotoClickRef.current = onPhotoClick

  const darkRef = useRef(dark)
  darkRef.current = dark

  const highlightMarker = useCallback((id: string | null) => {
    const prev = highlightedRef.current
    highlightedRef.current = id
    const isDark = !!darkRef.current

    if (prev && prev !== id) {
      const marker = markersRef.current.get(prev)
      const item = itemsRef.current.find(i => i.id === prev)
      if (marker && item) {
        marker.setIcon(L.divIcon({
          className: '',
          iconSize: [MARKER_W, MARKER_H],
          iconAnchor: [MARKER_W / 2, MARKER_H],
          html: markerSvg(item.dayColor, item.dayLabel, false),
        }))
        marker.setZIndexOffset(0)
      }
    }

    if (id) {
      const marker = markersRef.current.get(id)
      const item = itemsRef.current.find(i => i.id === id)
      if (marker && item) {
        marker.setIcon(L.divIcon({
          className: '',
          iconSize: [MARKER_W, MARKER_H],
          iconAnchor: [MARKER_W / 2, MARKER_H],
          html: markerSvg(item.dayColor, item.dayLabel, true),
        }))
        marker.setZIndexOffset(1000)
      }
    }
  }, [])

  const focusMarker = useCallback((id: string) => {
    highlightMarker(id)
    const marker = markersRef.current.get(id)
    if (marker && mapRef.current) {
      try {
        mapRef.current.flyTo(marker.getLatLng(), Math.max(mapRef.current.getZoom(), 12), { duration: 0.5 })
      } catch { /* map not yet initialized */ }
    }
  }, [])

  const invalidateSize = useCallback(() => {
    try { mapRef.current?.invalidateSize() } catch { /* map not yet initialized */ }
  }, [])

  useImperativeHandle(ref, () => ({ highlightMarker, focusMarker, invalidateSize }), [])

  useEffect(() => {
    if (!containerRef.current) return

    markersRef.current.clear()

    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: true,
      scrollWheelZoom: fullScreen ? true : false,
      dragging: true,
      touchZoom: true,
    })
    mapRef.current = map
    cancelledRef.current = false

    // The basemap is a vector style unless the user brought their own raster
    // template, so which layer draws it is decided per template rather than once.
    if (isVectorStyle(tileUrlRef.current)) {
      void attachVectorBasemap(map, tileUrlRef.current, glLayerRef, () => cancelledRef.current)
    } else {
      const tiles = L.tileLayer(tileUrlRef.current, {
        maxZoom: 18,
        attribution: attributionForTile(tileUrlRef.current),
        referrerPolicy: 'strict-origin-when-cross-origin',
        // Leaflet defaults updateWhenIdle:true on mobile (waits for pan to settle
        // before loading tiles). On the journey mobile combined view we flyTo
        // constantly when switching cards, so tiles lag visibly — force eager
        // updates and keep a larger ring of off-screen tiles ready.
        updateWhenIdle: false,
        keepBuffer: 4,
      } as any)
      tiles.addTo(map)
      tileLayerRef.current = tiles
    }

    const items = buildMarkerItems(entries)
    itemsRef.current = items

    const allCoords: L.LatLngTuple[] = []
    /**
     * Track geometry is kept OUT of the fit set (#2194) and used only when there
     * is nothing else to frame.
     *
     * A journey's opening viewport should show the journey — its entries and the
     * trail between them. Letting a recorded GPX into the bounds meant one drive
     * across a country zoomed the map out until the entries were specks, which
     * is what the reporter's screenshot shows. JourneyMapGL already fits on
     * entries + trail alone, so for every journey that has entries the two
     * renderers now agree where they used to differ.
     *
     * They still differ for a journey with tracks and nothing else: this one
     * frames the tracks, JourneyMapGL falls back to the world view. Framing the
     * only thing on the map is the better of the two, and converging the GL side
     * is a change to a renderer this issue is not about.
     */
    const trackCoords: L.LatLngTuple[] = []

    if (stableTrail.length > 1) {
      const coords = stableTrail.map(p => [p.lat, p.lng] as L.LatLngTuple)
      L.polyline(coords, {
        color: '#6366f1', weight: 3, opacity: 0.4,
        dashArray: '6 4', lineCap: 'round',
      }).addTo(map)
      coords.forEach(c => allCoords.push(c))
    }

    // GPX tracks — drawn solid and in their own colour, so they read as a recorded
    // route rather than as the dashed line that merely connects entries in time order.
    // A white casing keeps them legible on satellite tiles, same as the planner map.
    for (const track of stableTracks) {
      if (track.points.length < 2) continue
      const coords = track.points.map(([lat, lng]) => [lat, lng] as L.LatLngTuple)
      const color = track.color || TRACK_FALLBACK_COLOR
      L.polyline(coords, { color: '#ffffff', weight: 6, opacity: 0.75, lineCap: 'round', lineJoin: 'round' }).addTo(map)
      const line = L.polyline(coords, { color, weight: 3.5, opacity: 0.95, lineCap: 'round', lineJoin: 'round' })
      // Same tooltip the markers on this map use, rather than Leaflet's default box:
      // it follows the appearance tokens, so it lands right in dark mode and with
      // transparency switched off. Escaped because a string handed to bindTooltip
      // becomes innerHTML, and a track name is a place name off a shared trip.
      if (track.name) line.bindTooltip(escapeHtml(track.name), { sticky: true, direction: 'top', className: 'map-tooltip' })
      line.addTo(map)
      coords.forEach(c => trackCoords.push(c))
    }

    // route polyline — only in non-fullscreen (sidebar map) mode
    if (!fullScreen && items.length > 1) {
      const routeCoords = items.map(i => [i.lat, i.lng] as L.LatLngTuple)
      L.polyline(routeCoords, {
        color: dark ? '#71717A' : '#A1A1AA',
        weight: 1.5,
        opacity: 0.5,
        dashArray: '4 6',
        lineCap: 'round', lineJoin: 'round',
      }).addTo(map)
    }

    // place markers
    items.forEach((item, i) => {
      const pos: L.LatLngTuple = [item.lat, item.lng]
      allCoords.push(pos)

      const icon = L.divIcon({
        className: '',
        iconSize: [MARKER_W, MARKER_H],
        iconAnchor: [MARKER_W / 2, MARKER_H],
        html: markerSvg(item.dayColor, item.dayLabel, false),
      })

      const marker = L.marker(pos, { icon }).addTo(map)
      // Escaped for the same reason as the track tooltip above: the label is an
      // entry title, and this map is what the public journey page renders.
      marker.bindTooltip(escapeHtml(item.label), {
        direction: 'top',
        offset: [0, -MARKER_H],
        className: 'map-tooltip',
      })

      marker.on('click', () => {
        onMarkerClickRef.current?.(item.id)
      })

      markersRef.current.set(item.id, marker)
    })

    // fit bounds
    requestAnimationFrame(() => {
      if (!mapRef.current) return
      try {
        map.invalidateSize()
        // Tracks only get a say when the journey has nothing located of its own —
        // a world view would be worse than framing the one thing on the map.
        const fitCoords = allCoords.length > 0 ? allCoords : trackCoords
        if (fitCoords.length > 0) {
          const pb = paddingBottom || 50
          map.fitBounds(L.latLngBounds(fitCoords), { paddingTopLeft: [50, 50], paddingBottomRight: [50, pb], maxZoom: 16 })
        } else {
          map.setView([30, 0], 2)
        }
      } catch {}
    })

    setTimeout(() => {
      if (mapRef.current) map.invalidateSize()
    }, 200)

    return () => {
      cancelledRef.current = true
      map.remove()
      mapRef.current = null
      tileLayerRef.current = null
      glLayerRef.current?.remove()
      glLayerRef.current = null
      markersRef.current.clear()
    }
  }, [entries, stableTrail, stableTracks, dark, fullScreen, paddingBottom])

  // Retile in place rather than through the effect above, which would drop every
  // marker and track it just drew. A vector basemap restyles instead, which also
  // avoids spending a WebGL context on every theme toggle.
  useEffect(() => {
    if (isVectorStyle(tileUrl)) glLayerRef.current?.getMaplibreMap()?.setStyle(tileUrl)
    else tileLayerRef.current?.setUrl(tileUrl)
  }, [tileUrl])

  // Photo layer (#1614). Its own effect on purpose: photos arriving must not tear
  // down and rebuild the map the way the entry effect does. Redrawn on zoom and
  // pan because the clustering is done in screen space.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const draw = () => {
      photoLayerRef.current?.remove()
      photoLayerRef.current = null
      if (!photos?.length) return

      // The initial view (setView/fitBounds) is set on a deferred rAF in the
      // map-build effect above, so this can run before the map has a center/zoom
      // — latLngToContainerPoint throws in that window. Skip; the moveend/zoomend
      // listener below redraws once the deferred view lands.
      try {
        map.getCenter()
      } catch {
        return
      }

      const group = L.layerGroup()
      for (const cluster of clusterPhotos(map, photos)) {
        const marker = L.marker([cluster.lat, cluster.lng], {
          icon: L.divIcon({
            className: '',
            iconSize: [48, 48],
            iconAnchor: [24, 24],
            html: photoMarkerHtml(cluster.members[0].thumbUrl, cluster.members.length),
          }),
          // Below the entry pins: the itinerary is the point of the map, the photos
          // are context.
          zIndexOffset: -500,
        })
        marker.on('click', () => onPhotoClickRef.current?.(cluster.members.map(m => m.id)))
        group.addLayer(marker)
      }
      group.addTo(map)
      photoLayerRef.current = group
    }

    draw()
    map.on('zoomend', draw)
    map.on('moveend', draw)
    return () => {
      map.off('zoomend', draw)
      map.off('moveend', draw)
      photoLayerRef.current?.remove()
      photoLayerRef.current = null
    }
  }, [photos, entries, stableTrail, stableTracks, dark, fullScreen, paddingBottom])

  // react to activeMarkerId prop changes — runs after map is built
  useEffect(() => {
    if (!activeMarkerId || !mapRef.current) return
    // small delay to ensure markers are rendered after map build
    const timer = setTimeout(() => {
      highlightMarker(activeMarkerId)
      const marker = markersRef.current.get(activeMarkerId)
      if (!marker || !mapRef.current) return
      // fitBounds may still be pending when this fires — getZoom() throws
      // "Set map center and zoom first" until the map has a view. Guard it.
      try {
        const currentZoom = mapRef.current.getZoom()
        mapRef.current.flyTo(marker.getLatLng(), Math.max(currentZoom, 12), { duration: 0.5 })
      } catch {
        mapRef.current.setView(marker.getLatLng(), 12)
      }
    }, 50)
    return () => clearTimeout(timer)
  }, [activeMarkerId])

  const zoomIn = () => mapRef.current?.zoomIn()
  const zoomOut = () => mapRef.current?.zoomOut()

  return (
    <div style={{ position: 'relative', height: height === 9999 ? '100%' : height, width: '100%', borderRadius: 'inherit', overflow: 'hidden' }}>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%' }}
      />
      <div style={{ position: 'absolute', bottom: 12, right: 12, zIndex: 400, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button type="button"
          onClick={zoomIn}
          style={{
            width: 32, height: 32, borderRadius: 8,
            background: dark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.9)',
            backdropFilter: 'blur(8px)',
            border: `1px solid ${dark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)'}`,
            color: dark ? '#fff' : '#18181B',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontSize: 'calc(16px * var(--fs-scale-subtitle, 1))', fontWeight: 700, lineHeight: 1,
          }}
        >+</button>
        <button type="button"
          onClick={zoomOut}
          style={{
            width: 32, height: 32, borderRadius: 8,
            background: dark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.9)',
            backdropFilter: 'blur(8px)',
            border: `1px solid ${dark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)'}`,
            color: dark ? '#fff' : '#18181B',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontSize: 'calc(16px * var(--fs-scale-subtitle, 1))', fontWeight: 700, lineHeight: 1,
          }}
        >−</button>
      </div>
    </div>
  )
}

export default JourneyMap
