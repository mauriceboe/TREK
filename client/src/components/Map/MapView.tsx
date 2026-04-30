import { useEffect, useRef, useState, useMemo, useCallback, createElement, memo } from 'react'
import DOM from 'react-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { MapContainer, TileLayer, Marker, Polyline, CircleMarker, Circle, useMap } from 'react-leaflet'
import MarkerClusterGroup from 'react-leaflet-cluster'
import L from 'leaflet'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import { mapsApi } from '../../api/client'
import { getCategoryIcon, CATEGORY_ICON_MAP } from '../shared/categoryIcons'
import ReservationOverlay from './ReservationOverlay'
import type { Reservation } from '../../types'

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

  // Prefer base64 data URLs (no zoom lag); also accept same-origin proxy URLs as a fallback
  // while the thumb is still being generated in the background
  if (place.image_url && (place.image_url.startsWith('data:') || place.image_url.startsWith('/api/maps/place-photo/'))) {
    const imgIcon = L.divIcon({
      className: '',
      html: `<div style="
        width:${size}px;height:${size}px;
        cursor:pointer;position:relative;
      ">
        <div style="
          width:${size}px;height:${size}px;border-radius:50%;
          border:${borderWidth}px solid ${borderColor};
          box-shadow:${shadow};
          overflow:hidden;background:${bgColor};
        ">
          <img src="${place.image_url}" width="${size}" height="${size}" style="display:block;border-radius:50%;object-fit:cover;" />
        </div>
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
  hasDayDetail?: boolean
  places: Place[]
  fitKey: number
  paddingOpts: Record<string, number>
}

function BoundsController({ places, fitKey, paddingOpts, hasDayDetail }: BoundsControllerProps) {
  const map = useMap()
  const prevFitKey = useRef(-1)

  useEffect(() => {
    if (fitKey === prevFitKey.current) return
    prevFitKey.current = fitKey
    if (places.length === 0) return
    try {
      const bounds = L.latLngBounds(places.map(p => [p.lat, p.lng]))
      if (bounds.isValid()) {
        map.fitBounds(bounds, { ...paddingOpts, maxZoom: 16, animate: true })
        if (hasDayDetail) {
          setTimeout(() => map.panBy([0, 150], { animate: true }), 300)
        }
      }
    } catch {}
  }, [fitKey]) // eslint-disable-line react-hooks/exhaustive-deps

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
  if (!midpoint) return null

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
import { useAuthStore } from '../../store/authStore'
import { useGeolocation } from '../../hooks/useGeolocation'
import LocationButton from './LocationButton'

// Live-location rendering inside the Leaflet map. Subscribes via the
// shared useGeolocation hook so the Leaflet and Mapbox variants behave
// identically. Heading is shown as a rotated conic SVG when available.
import type { GeoPosition, TrackingMode } from '../../hooks/useGeolocation'

function LeafletLocationLayer({ position, mode }: { position: GeoPosition | null; mode: TrackingMode }) {
  const map = useMap()

  // When the user is in follow mode, keep the map centred on the dot.
  // setView (no animation) is what Google Maps does during navigation —
  // it feels responsive and avoids animation jitter at walking speed.
  useEffect(() => {
    if (mode !== 'follow' || !position) return
    try { map.setView([position.lat, position.lng], Math.max(map.getZoom(), 16), { animate: true, duration: 0.35 }) } catch { /* noop */ }
  }, [position, mode, map])

  // Once, when the user first acquires a fix in "show" mode, pan to it so
  // they don't have to scroll the map. Subsequent fixes only move the dot.
  const centeredRef = useRef(false)
  useEffect(() => {
    if (mode === 'off') { centeredRef.current = false; return }
    if (!position || centeredRef.current) return
    try { map.setView([position.lat, position.lng], Math.max(map.getZoom(), 15)) } catch { /* noop */ }
    centeredRef.current = true
  }, [position, mode, map])

  if (!position) return null

  const headingIcon = position.heading === null || Number.isNaN(position.heading) ? null : L.divIcon({
    className: '',
    iconSize: [60, 60],
    iconAnchor: [30, 30],
    html: `<div style="
      width:60px;height:60px;
      transform:rotate(${position.heading}deg);transition:transform 120ms ease-out;
      background:conic-gradient(from -30deg, rgba(59,130,246,0) 0deg, rgba(59,130,246,0.35) 15deg, rgba(59,130,246,0) 60deg, rgba(59,130,246,0) 360deg);
      border-radius:50%;
      -webkit-mask:radial-gradient(circle, transparent 12px, black 13px);
      mask:radial-gradient(circle, transparent 12px, black 13px);
      pointer-events:none;
    "></div>`,
  })

  return (
    <>
      {position.accuracy < 500 && (
        <Circle
          center={[position.lat, position.lng]}
          radius={position.accuracy}
          pathOptions={{ color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.12, weight: 1, opacity: 0.35 }}
          interactive={false}
        />
      )}
      {headingIcon && (
        <Marker
          position={[position.lat, position.lng]}
          icon={headingIcon}
          interactive={false}
          zIndexOffset={900}
        />
      )}
      <CircleMarker
        center={[position.lat, position.lng]}
        radius={8}
        pathOptions={{ color: 'white', fillColor: '#3b82f6', fillOpacity: 1, weight: 3 }}
        interactive={false}
      />
    </>
  )
}

interface MemoMarkerProps {
  place: any
  isSelected: boolean
  orderNumbers: number[] | null
  photoUrl: string | null
  onClickPlace: (id: number) => void
  onHover: (place: any, x: number, y: number) => void
  onHoverOut: () => void
}

const MemoMarker = memo(function MemoMarker({
  place, isSelected, orderNumbers, photoUrl, onClickPlace, onHover, onHoverOut,
}: MemoMarkerProps) {
  const icon = createPlaceIcon({ ...place, image_url: photoUrl }, orderNumbers, isSelected)
  return (
    <Marker
      position={[place.lat, place.lng]}
      icon={icon}
      eventHandlers={{
        click: () => onClickPlace(place.id),
        mouseover: (e: any) => onHover(place, e.originalEvent.clientX, e.originalEvent.clientY),
        mousemove: (e: any) => onHover(place, e.originalEvent.clientX, e.originalEvent.clientY),
        mouseout: onHoverOut,
      }}
      zIndexOffset={isSelected ? 1000 : 0}
    />
  )
})

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
  hasDayDetail = false,
  reservations = [] as Reservation[],
  showReservationStats = false,
  visibleConnectionIds = [] as number[],
  onReservationClick,
}: any) {
  const visibleReservations = useMemo(() => {
    if (!visibleConnectionIds || visibleConnectionIds.length === 0) return []
    const set = new Set(visibleConnectionIds)
    return reservations.filter((r: Reservation) => set.has(r.id))
  }, [reservations, visibleConnectionIds])
  // Dynamic padding: account for sidebars + bottom inspector + day detail panel
  const paddingOpts = useMemo(() => {
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
    if (isMobile) return { padding: [40, 20] }
    const top = 60
    const bottom = hasInspector ? 320 : hasDayDetail ? 280 : 60
    const left = leftWidth + 40
    const right = rightWidth + 40
    return { paddingTopLeft: [left, top], paddingBottomRight: [right, bottom] }
  }, [leftWidth, rightWidth, hasInspector, hasDayDetail])

  // Hover state for the single tooltip overlay (replaces per-marker <Tooltip>)
  const [hoveredPlace, setHoveredPlace] = useState<any>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)

  const handleMarkerHover = useCallback((place: any, x: number, y: number) => {
    setHoveredPlace(place)
    setTooltipPos({ x, y })
  }, [])

  const handleMarkerHoverOut = useCallback(() => {
    setHoveredPlace(null)
  }, [])

  const handleMarkerClick = useCallback((id: number) => {
    onMarkerClick?.(id)
  }, [onMarkerClick])

  // photoUrls: only base64 thumbs for smooth map zoom
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>(getAllThumbs)
  const placesPhotosEnabled = useAuthStore(s => s.placesPhotosEnabled)
  // Batch photo state updates through a RAF so N simultaneous photo loads
  // collapse into a single re-render instead of N separate renders.
  const pendingThumbsRef = useRef<Record<string, string>>({})
  const thumbRafRef = useRef<number | null>(null)

  const placeIds = useMemo(() => places.map(p => p.id).join(','), [places])
  useEffect(() => {
    if (!places || places.length === 0 || !placesPhotosEnabled) return
    const cleanups: (() => void)[] = []

    const setThumb = (cacheKey: string, thumb: string) => {
      pendingThumbsRef.current[cacheKey] = thumb
      if (thumbRafRef.current !== null) return
      thumbRafRef.current = requestAnimationFrame(() => {
        thumbRafRef.current = null
        const pending = pendingThumbsRef.current
        pendingThumbsRef.current = {}
        setPhotoUrls(prev => {
          const hasChange = Object.entries(pending).some(([k, v]) => prev[k] !== v)
          return hasChange ? { ...prev, ...pending } : prev
        })
      })
    }

    for (const place of places) {
      const cacheKey = place.google_place_id || place.osm_id || `${place.lat},${place.lng}`
      if (!cacheKey) continue

      const cached = getCached(cacheKey)
      if (cached?.thumbDataUrl) {
        setThumb(cacheKey, cached.thumbDataUrl)
        continue
      }

      cleanups.push(onThumbReady(cacheKey, thumb => setThumb(cacheKey, thumb)))

      if (!cached && !isLoading(cacheKey)) {
        const photoId =
          (place.image_url?.startsWith('/api/maps/place-photo/') ? place.image_url : null)
          || place.google_place_id
          || place.osm_id
          || place.image_url
        if (photoId || (place.lat && place.lng)) {
          fetchPhoto(cacheKey, photoId || `coords:${place.lat}:${place.lng}`, place.lat, place.lng, place.name)
        }
      }
    }

    return () => {
      cleanups.forEach(fn => fn())
      if (thumbRafRef.current !== null) {
        cancelAnimationFrame(thumbRafRef.current)
        thumbRafRef.current = null
      }
    }
  }, [placeIds, placesPhotosEnabled])

  const clusterIconCreateFunction = useCallback((cluster) => {
    const count = cluster.getChildCount()
    const size = count < 10 ? 36 : count < 50 ? 42 : 48
    return L.divIcon({
      html: `<div class="marker-cluster-custom" style="width:${size}px;height:${size}px;"><span>${count}</span></div>`,
      className: 'marker-cluster-wrapper',
      iconSize: L.point(size, size),
    })
  }, [])

  const isTouchDevice = typeof window !== 'undefined' && navigator.maxTouchPoints > 0

  const markers = useMemo(() => places.map((place) => {
    const isSelected = place.id === selectedPlaceId
    const pck = place.google_place_id || place.osm_id || `${place.lat},${place.lng}`
    const photoUrl = (pck && photoUrls[pck]) || place.image_url || null
    const orderNumbers = dayOrderMap[place.id] ?? null
    return (
      <MemoMarker
        key={place.id}
        place={place}
        isSelected={isSelected}
        orderNumbers={orderNumbers}
        photoUrl={photoUrl}
        onClickPlace={handleMarkerClick}
        onHover={handleMarkerHover}
        onHoverOut={handleMarkerHoverOut}
      />
    )
  }), [places, selectedPlaceId, dayOrderMap, photoUrls, handleMarkerClick, handleMarkerHover, handleMarkerHoverOut])

  const gpxPolylines = useMemo(() => places.flatMap(place => {
    if (!place.route_geometry) return []
    try {
      const coords = JSON.parse(place.route_geometry) as [number, number][]
      if (!coords || coords.length < 2) return []
      return [(
        <Polyline
          key={`gpx-${place.id}`}
          positions={coords}
          color={place.category_color || '#3b82f6'}
          weight={3.5}
          opacity={0.75}
        />
      )]
    } catch { return [] }
  }), [places])

  const TooltipOverlay = hoveredPlace && tooltipPos && !isTouchDevice
  const CatIcon = TooltipOverlay ? getCategoryIcon(hoveredPlace.category_icon) : null

  const { position: userPosition, mode: trackingMode, error: trackingError, cycleMode: cycleTrackingMode } = useGeolocation()
  // Desktop browsers only get IP-based geolocation (city-level accuracy),
  // so the button would be misleading. Mobile, where real GPS lives, keeps it.
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const locationButtonBottom = 'calc(var(--bottom-nav-h, 84px) + 12px)'

  return (
    <>
    <div className="w-full h-full relative">
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
      <BoundsController places={dayPlaces.length > 0 ? dayPlaces : places} fitKey={fitKey} paddingOpts={paddingOpts} hasDayDetail={hasDayDetail} />
      <SelectionController places={places} selectedPlaceId={selectedPlaceId} dayPlaces={dayPlaces} paddingOpts={paddingOpts} />
      <MapClickHandler onClick={onMapClick} />
      <MapContextMenuHandler onContextMenu={onMapContextMenu} />
      <LeafletLocationLayer position={userPosition} mode={trackingMode} />

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

      {route && route.length > 0 && (
        <>
          {route.map((seg, i) => seg.length > 1 && (
            <Polyline
              key={i}
              positions={seg}
              color="#111827"
              weight={3}
              opacity={0.9}
              dashArray="6, 5"
            />
          ))}
          {routeSegments.map((seg, i) => (
            <RouteLabel key={i} midpoint={seg.mid} from={seg.from} to={seg.to} walkingText={seg.walkingText} drivingText={seg.drivingText} />
          ))}
        </>
      )}

      {/* GPX imported route geometries */}
      {gpxPolylines}

      <ReservationOverlay
        reservations={visibleReservations}
        showConnections
        showStats={showReservationStats}
        onEndpointClick={onReservationClick}
      />
    </MapContainer>
    {isMobile && <LocationButton
      mode={trackingMode}
      error={trackingError}
      onClick={cycleTrackingMode}
      bottomOffset={locationButtonBottom as unknown as number}
    />}
    </div>

    {TooltipOverlay && (
      <div data-testid="tooltip" style={{
        position: 'fixed',
        left: tooltipPos.x + 14,
        top: tooltipPos.y - 10,
        zIndex: 9999,
        pointerEvents: 'none',
        background: 'white',
        borderRadius: 8,
        boxShadow: '0 2px 10px rgba(0,0,0,0.15)',
        padding: '6px 10px',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
        maxWidth: 220,
        whiteSpace: 'nowrap',
      }}>
        <div style={{ fontWeight: 600, fontSize: 12, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {hoveredPlace.name}
        </div>
        {hoveredPlace.category_name && CatIcon && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 1 }}>
            <CatIcon size={10} style={{ color: hoveredPlace.category_color || '#6b7280', flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: '#6b7280' }}>{hoveredPlace.category_name}</span>
          </div>
        )}
        {hoveredPlace.address && (
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {hoveredPlace.address}
          </div>
        )}
      </div>
    )}
    </>
  )
})
