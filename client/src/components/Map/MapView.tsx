import { useEffect, useRef, useState, useMemo, useCallback, createElement, memo } from 'react'
import DOM from 'react-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { MapContainer, TileLayer, Marker, Tooltip, Polyline, CircleMarker, Circle, useMap } from 'react-leaflet'
import MarkerClusterGroup from 'react-leaflet-cluster'
import L from 'leaflet'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import { mapsApi } from '../../api/client'
import { getCategoryIcon, CATEGORY_ICON_MAP } from '../shared/categoryIcons'

function categoryIconSvg(iconName: string | null | undefined, size: number): string {
  const IconComponent = (iconName && CATEGORY_ICON_MAP[iconName]) || CATEGORY_ICON_MAP['MapPin']
  try {
    return renderToStaticMarkup(createElement(IconComponent, { size, color: 'white', strokeWidth: 2.5 }))
  } catch { return '' }
}
import type { Place } from '../../types'

// Fix default marker icons for vite
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
})

/**
 * Create a round photo-circle marker.
 * Shows image_url if available, otherwise category icon in colored circle.
 */
function escAttr(s) {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const iconCache = new Map<string, L.DivIcon>()

function createPlaceIcon(place, orderNumbers, isSelected) {
  const cacheKey = `${place.id}:${isSelected}:${place.image_url || ''}:${place.category_color || ''}:${place.category_icon || ''}:${orderNumbers?.join(',') || ''}`
  const cached = iconCache.get(cacheKey)
  if (cached) return cached
  const size = isSelected ? 44 : 36
  const borderColor = isSelected ? '#111827' : 'white'
  const borderWidth = isSelected ? 3 : 2.5
  const shadow = isSelected
    ? '0 0 0 3px rgba(17,24,39,0.25), 0 4px 14px rgba(0,0,0,0.3)'
    : '0 2px 8px rgba(0,0,0,0.22)'
  const bgColor = place.category_color || '#6b7280'

  // Number badges (bottom-right)
  let badgeHtml = ''
  if (orderNumbers && orderNumbers.length > 0) {
    const label = orderNumbers.join(' · ')
    badgeHtml = `<span style="
      position:absolute;bottom:-4px;right:-4px;
      min-width:18px;height:${orderNumbers.length > 1 ? 16 : 18}px;border-radius:${orderNumbers.length > 1 ? 8 : 9}px;
      padding:0 ${orderNumbers.length > 1 ? 4 : 3}px;
      background:rgba(255,255,255,0.94);
      border:1.5px solid rgba(0,0,0,0.15);
      box-shadow:0 1px 4px rgba(0,0,0,0.18);
      display:flex;align-items:center;justify-content:center;
      font-size:${orderNumbers.length > 1 ? 7.5 : 9}px;font-weight:800;color:#111827;
      font-family:-apple-system,system-ui,sans-serif;line-height:1;
      box-sizing:border-box;white-space:nowrap;
    ">${label}</span>`
  }

  // Base64 data URL thumbnails — no external image fetch during zoom
  // Only use base64 data URLs for markers — external URLs cause zoom lag
  if (place.image_url && place.image_url.startsWith('data:')) {
    const imgIcon = L.divIcon({
      className: '',
      html: `<div style="
        width:${size}px;height:${size}px;border-radius:50%;
        border:${borderWidth}px solid ${borderColor};
        box-shadow:${shadow};
        overflow:hidden;background:${bgColor};
        cursor:pointer;position:relative;
      ">
        <img src="${place.image_url}" width="${size}" height="${size}" style="display:block;border-radius:50%;object-fit:cover;" />
        ${badgeHtml}
      </div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      tooltipAnchor: [size / 2 + 6, 0],
    })
    iconCache.set(cacheKey, imgIcon)
    return imgIcon
  }

  const fallbackIcon = L.divIcon({
    className: '',
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      border:${borderWidth}px solid ${borderColor};
      box-shadow:${shadow};
      background:${bgColor};
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;position:relative;
      will-change:transform;contain:layout style;
    ">
      ${categoryIconSvg(place.category_icon, isSelected ? 18 : 15)}
      ${badgeHtml}
    </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    tooltipAnchor: [size / 2 + 6, 0],
  })
  iconCache.set(cacheKey, fallbackIcon)
  return fallbackIcon
}

interface SelectionControllerProps {
  places: Place[]
  selectedPlaceId: number | null
  dayPlaces: Place[]
  paddingOpts: Record<string, number>
}

function SelectionController({ places, selectedPlaceId, dayPlaces, paddingOpts }: SelectionControllerProps) {
  const map = useMap()
  const prev = useRef(null)

  useEffect(() => {
    if (selectedPlaceId && selectedPlaceId !== prev.current) {
      // Pan to the selected place without changing zoom
      const selected = places.find(p => p.id === selectedPlaceId)
      if (selected?.lat && selected?.lng) {
        map.panTo([selected.lat, selected.lng], { animate: true })
      }
    }
    prev.current = selectedPlaceId
  }, [selectedPlaceId, places, map])

  return null
}

interface MapControllerProps {
  center: [number, number]
  zoom: number
}

function MapController({ center, zoom }: MapControllerProps) {
  const map = useMap()
  const prevCenter = useRef(center)

  useEffect(() => {
    if (prevCenter.current[0] !== center[0] || prevCenter.current[1] !== center[1]) {
      map.setView(center, zoom)
      prevCenter.current = center
    }
  }, [center, zoom, map])

  return null
}

// Fit bounds when places change (fitKey triggers re-fit)
interface BoundsControllerProps {
  places: Place[]
  fitKey: number
  paddingOpts: Record<string, number>
}

function BoundsController({ places, fitKey, paddingOpts }: BoundsControllerProps) {
  const map = useMap()
  const prevFitKey = useRef(-1)

  useEffect(() => {
    if (fitKey === prevFitKey.current) return
    prevFitKey.current = fitKey
    if (places.length === 0) return
    try {
      const bounds = L.latLngBounds(places.map(p => [p.lat, p.lng]))
      if (bounds.isValid()) map.fitBounds(bounds, { ...paddingOpts, maxZoom: 16, animate: true })
    } catch {}
  }, [fitKey, places, paddingOpts, map])

  return null
}

interface MapClickHandlerProps {
  onClick: ((e: L.LeafletMouseEvent) => void) | null
}

function ZoomTracker({ onZoomStart, onZoomEnd }: { onZoomStart: () => void; onZoomEnd: () => void }) {
  const map = useMap()
  useEffect(() => {
    map.on('zoomstart', onZoomStart)
    map.on('zoomend', onZoomEnd)
    return () => { map.off('zoomstart', onZoomStart); map.off('zoomend', onZoomEnd) }
  }, [map, onZoomStart, onZoomEnd])
  return null
}

function MapClickHandler({ onClick }: MapClickHandlerProps) {
  const map = useMap()
  useEffect(() => {
    if (!onClick) return
    map.on('click', onClick)
    return () => map.off('click', onClick)
  }, [map, onClick])
  return null
}

function MapContextMenuHandler({ onContextMenu }: { onContextMenu: ((e: L.LeafletMouseEvent) => void) | null }) {
  const map = useMap()
  useEffect(() => {
    if (!onContextMenu) return
    map.on('contextmenu', onContextMenu)
    return () => map.off('contextmenu', onContextMenu)
  }, [map, onContextMenu])
  return null
}

// ── Route travel time label ──
interface RouteLabelProps {
  midpoint: [number, number]
  walkingText: string
  drivingText: string
}

function RouteLabel({ midpoint, walkingText, drivingText }: RouteLabelProps) {
  const map = useMap()
  const [visible, setVisible] = useState(map ? map.getZoom() >= 12 : false)

  useEffect(() => {
    if (!map) return
    const check = () => setVisible(map.getZoom() >= 12)
    check()
    map.on('zoomend', check)
    return () => map.off('zoomend', check)
  }, [map])

  if (!visible || !midpoint) return null

  const icon = L.divIcon({
    className: 'route-info-pill',
    html: `<div style="
      display:flex;align-items:center;gap:5px;
      background:rgba(0,0,0,0.85);backdrop-filter:blur(8px);
      color:#fff;border-radius:99px;padding:3px 9px;
      font-size:9px;font-weight:600;white-space:nowrap;
      font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
      box-shadow:0 2px 12px rgba(0,0,0,0.3);
      pointer-events:none;
      position:relative;left:-50%;top:-50%;
    ">
      <span style="display:flex;align-items:center;gap:2px">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2"/><path d="M7 21l3-7"/><path d="M10 14l5-5"/><path d="M15 9l-4 7"/><path d="M18 18l-3-7"/></svg>
        ${walkingText}
      </span>
      <span style="opacity:0.3">|</span>
      <span style="display:flex;align-items:center;gap:2px">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9L18 10l-2-4H7L5 10l-2.5 1.1C1.7 11.3 1 12.1 1 13v3c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>
        ${drivingText}
      </span>
    </div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })

  return <Marker position={midpoint} icon={icon} interactive={false} zIndexOffset={2000} />
}

// Module-level photo cache shared with PlaceAvatar
import { getCached, isLoading, fetchPhoto, onThumbReady, getAllThumbs } from '../../services/photoService'

// Live location tracker — blue dot with pulse animation (like Apple/Google Maps)
function LocationTracker() {
  const map = useMap()
  const [position, setPosition] = useState<[number, number] | null>(null)
  const [accuracy, setAccuracy] = useState(0)
  const [tracking, setTracking] = useState(false)
  const watchId = useRef<number | null>(null)

  const startTracking = useCallback(() => {
    if (!('geolocation' in navigator)) return
    setTracking(true)
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        const latlng: [number, number] = [pos.coords.latitude, pos.coords.longitude]
        setPosition(latlng)
        setAccuracy(pos.coords.accuracy)
      },
      () => setTracking(false),
      { enableHighAccuracy: true, maximumAge: 5000 }
    )
  }, [])

  const stopTracking = useCallback(() => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current)
    watchId.current = null
    setTracking(false)
    setPosition(null)
  }, [])

  const toggleTracking = useCallback(() => {
    if (tracking) { stopTracking() } else { startTracking() }
  }, [tracking, startTracking, stopTracking])

  // Center map on position when first acquired
  const centered = useRef(false)
  useEffect(() => {
    if (position && !centered.current) {
      map.setView(position, 15)
      centered.current = true
    }
  }, [position, map])

  // Cleanup on unmount
  useEffect(() => () => { if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current) }, [])

  return (
    <>
      {/* Location button */}
      <div style={{
        position: 'absolute', bottom: 20, right: 10, zIndex: 1000,
      }}>
        <button onClick={toggleTracking} style={{
          width: 36, height: 36, borderRadius: '50%',
          border: 'none', cursor: 'pointer',
          background: tracking ? '#3b82f6' : 'var(--bg-card, white)',
          color: tracking ? 'white' : 'var(--text-muted, #6b7280)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 0.2s, color 0.2s',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
          </svg>
        </button>
      </div>

      {/* Blue dot + accuracy circle */}
      {position && (
        <>
          {accuracy < 500 && (
            <Circle center={position} radius={accuracy} pathOptions={{ color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.06, weight: 0.5, opacity: 0.3 }} />
          )}
          <CircleMarker center={position} radius={7} pathOptions={{ color: 'white', fillColor: '#3b82f6', fillOpacity: 1, weight: 2.5 }} />
        </>
      )}

      {/* Pulse animation CSS */}
      {position && (
        <style>{`
          @keyframes location-pulse {
            0% { transform: scale(1); opacity: 0.6; }
            100% { transform: scale(2.5); opacity: 0; }
          }
        `}</style>
      )}
    </>
  )
}

export const MapView = memo(function MapView({
  places = [],
  dayPlaces = [],
  route = null,
  routeSegments = [],
  selectedPlaceId = null,
  onMarkerClick,
  onMapClick,
  onMapContextMenu = null,
  center = [48.8566, 2.3522],
  zoom = 10,
  tileUrl = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  fitKey = 0,
  dayOrderMap = {},
  leftWidth = 0,
  rightWidth = 0,
  hasInspector = false,
}) {
  // Dynamic padding: account for sidebars + bottom inspector
  const paddingOpts = useMemo(() => {
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
    if (isMobile) return { padding: [40, 20] }
    const top = 60
    const bottom = hasInspector ? 320 : 60
    const left = leftWidth + 40
    const right = rightWidth + 40
    return { paddingTopLeft: [left, top], paddingBottomRight: [right, bottom] }
  }, [leftWidth, rightWidth, hasInspector])

  // photoUrls: only base64 thumbs for smooth map zoom
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>(getAllThumbs)

  // Fetch photos via shared service — subscribe to thumb (base64) availability
  const placeIds = useMemo(() => places.map(p => p.id).join(','), [places])
  useEffect(() => {
    if (!places || places.length === 0) return
    const cleanups: (() => void)[] = []

    const setThumb = (cacheKey: string, thumb: string) => {
      iconCache.clear()
      setPhotoUrls(prev => prev[cacheKey] === thumb ? prev : { ...prev, [cacheKey]: thumb })
    }

    for (const place of places) {
      if (place.image_url && place.image_url.startsWith('data:')) continue
      const cacheKey = place.google_place_id || place.osm_id || `${place.lat},${place.lng}`
      if (!cacheKey) continue

      const cached = getCached(cacheKey)
      if (cached?.thumbDataUrl) {
        setThumb(cacheKey, cached.thumbDataUrl)
        continue
      }

      // Subscribe for when thumb becomes available
      cleanups.push(onThumbReady(cacheKey, thumb => setThumb(cacheKey, thumb)))

      // Always fetch through API — returns fresh URL + converts to base64
      if (!cached && !isLoading(cacheKey)) {
        const photoId = place.google_place_id || place.osm_id
        if (photoId || (place.lat && place.lng)) {
          fetchPhoto(cacheKey, photoId || `coords:${place.lat}:${place.lng}`, place.lat, place.lng, place.name)
        }
      }
    }

    return () => cleanups.forEach(fn => fn())
  }, [placeIds])

  const clusterIconCreateFunction = useCallback((cluster) => {
    const count = cluster.getChildCount()
    const size = count < 10 ? 36 : count < 50 ? 42 : 48
    return L.divIcon({
      html: `<div class="marker-cluster-custom" style="width:${size}px;height:${size}px;"><span>${count}</span></div>`,
      className: 'marker-cluster-wrapper',
      iconSize: L.point(size, size),
    })
  }, [])

  const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)

  const markers = useMemo(() => places.map((place) => {
    const isSelected = place.id === selectedPlaceId
    const pck = place.google_place_id || place.osm_id || `${place.lat},${place.lng}`
    const resolvedPhoto = (pck && photoUrls[pck]) || (place.image_url?.startsWith('data:') ? place.image_url : null) || null
    const orderNumbers = dayOrderMap[place.id] ?? null
    const icon = createPlaceIcon({ ...place, image_url: resolvedPhoto }, orderNumbers, isSelected)

    return (
      <Marker
        key={place.id}
        position={[place.lat, place.lng]}
        icon={icon}
        eventHandlers={{
          click: () => onMarkerClick && onMarkerClick(place.id),
        }}
        zIndexOffset={isSelected ? 1000 : 0}
      >
        <Tooltip
          direction="right"
          offset={[0, 0]}
          opacity={1}
          className="map-tooltip"
          permanent={isTouchDevice && isSelected}
        >
          <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
              {place.name}
            </div>
            {place.category_name && (() => {
              const CatIcon = getCategoryIcon(place.category_icon)
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 1 }}>
                  <CatIcon size={10} style={{ color: place.category_color || 'var(--text-muted)', flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{place.category_name}</span>
                </div>
              )
            })()}
            {place.address && (
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2, maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {place.address}
              </div>
            )}
          </div>
        </Tooltip>
      </Marker>
    )
  }), [places, selectedPlaceId, dayOrderMap, photoUrls, onMarkerClick, isTouchDevice])

  return (
    <MapContainer
      id="trek-map"
      center={center}
      zoom={zoom}
      zoomControl={false}
      className="w-full h-full"
      style={{ background: '#e5e7eb' }}
    >
      <TileLayer
        url={tileUrl}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        maxZoom={19}
        keepBuffer={8}
        updateWhenZooming={false}
        updateWhenIdle={true}
        referrerPolicy="strict-origin-when-cross-origin"
      />

      <MapController center={center} zoom={zoom} />
      <BoundsController places={dayPlaces.length > 0 ? dayPlaces : places} fitKey={fitKey} paddingOpts={paddingOpts} />
      <SelectionController places={places} selectedPlaceId={selectedPlaceId} dayPlaces={dayPlaces} paddingOpts={paddingOpts} />
      <MapClickHandler onClick={onMapClick} />
      <MapContextMenuHandler onContextMenu={onMapContextMenu} />
      <LocationTracker />

      <MarkerClusterGroup
        chunkedLoading
        chunkInterval={30}
        chunkDelay={0}
        maxClusterRadius={30}
        disableClusteringAtZoom={11}
        spiderfyOnMaxZoom
        showCoverageOnHover={false}
        zoomToBoundsOnClick
        animate={false}
        iconCreateFunction={clusterIconCreateFunction}
      >
        {markers}
      </MarkerClusterGroup>

      {route && route.length > 1 && (
        <>
          <Polyline
            positions={route}
            color="#111827"
            weight={3}
            opacity={0.9}
            dashArray="6, 5"
          />
          {routeSegments.map((seg, i) => (
            <RouteLabel key={i} midpoint={seg.mid} from={seg.from} to={seg.to} walkingText={seg.walkingText} drivingText={seg.drivingText} />
          ))}
        </>
      )}

      {/* GPX imported route geometries */}
      {places.map((place) => {
        if (!place.route_geometry) return null
        try {
          const coords = JSON.parse(place.route_geometry) as [number, number][]
          if (!coords || coords.length < 2) return null
          return (
            <Polyline
              key={`gpx-${place.id}`}
              positions={coords}
              color={place.category_color || '#3b82f6'}
              weight={3.5}
              opacity={0.75}
            />
          )
        } catch { return null }
      })}
    </MapContainer>
  )
})
