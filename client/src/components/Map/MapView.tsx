import { useEffect, useRef, useState, useMemo, useCallback, createElement, memo } from 'react'
import DOM from 'react-dom'
import { renderIconMarkup } from '../../utils/iconMarkup'
import { MapContainer, TileLayer, Marker, Polyline, CircleMarker, Circle, useMap, Tooltip } from 'react-leaflet'
import MarkerClusterGroup from 'react-leaflet-cluster'
import { makeMarkerDraggable } from './markerDrag'
import L from 'leaflet'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import { mapsApi } from '../../api/client'
import { getCategoryIcon, CATEGORY_ICON_MAP } from '../shared/categoryIcons'
import ReservationOverlay from './ReservationOverlay'
import { PluginMapMarkers } from './MapPluginMarkers'
import { PluginMapLayers } from './MapPluginLayers'
import { useTransportRoutes } from '../../hooks/useTransportRoutes'
import { visibleRouteReservations } from '../../utils/reservationRoutes'
import { safeHexColor } from '../../utils/safeColor'
import { escapeHtml } from '@trek/shared'
import type { Day, Reservation, RouteVia } from '../../types'
import { POI_CATEGORY_BY_KEY, type Poi } from './poiCategories'
import { resolveTrackColor, hasManualTrackColor } from './trackColors'
import { OFM_POSITRON, DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM, MAP_MAX_ZOOM, SATELLITE_TILE_URL, SATELLITE_TILE_ATTRIBUTION, SATELLITE_TILE_MAXZOOM, AMAP_SATELLITE, attributionForTile } from '../../constants/mapDefaults'
import { crsForBasemap } from './gcj02Crs'
import { isGcj02Basemap, resolveBasemap } from '../../utils/tileUrl'
import VectorBasemap from './VectorBasemap'
import { useSettingsStore } from '../../store/settingsStore'
import { MapLayerSwitcher } from './MapLayerSwitcher'
import { computeMapViewport, TILE_SIZE_RASTER, type ViewportPadding } from '../../utils/mapViewport'

function categoryIconSvg(iconName: string | null | undefined, size: number): string {
  const IconComponent = (iconName && CATEGORY_ICON_MAP[iconName]) || CATEGORY_ICON_MAP['MapPin']
  try {
    return renderIconMarkup(createElement(IconComponent, { size, color: 'white', strokeWidth: 2.5 }))
  } catch { return '' }
}
import type { Place } from '../../types'

// Fix default marker icons for vite. `_getIconUrl` is a Leaflet-internal field
// not present in the public typings, so narrow to delete it.
delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
})

const iconCache = new Map<string, L.DivIcon>()

// Tone dot for a plugin route's via points (charging stops, rest areas) — smaller
// than the plugin markers so the day route's own stops stay visually dominant.
const VIA_TONE_COLORS: Record<string, string> = {
  default: '#4F46E5', success: '#10b981', warn: '#f59e0b', danger: '#ef4444',
}
const viaIconCache = new Map<string, L.DivIcon>()
function routeViaIcon(tone: string): L.DivIcon {
  const cached = viaIconCache.get(tone)
  if (cached) return cached
  const color = VIA_TONE_COLORS[tone] ?? VIA_TONE_COLORS.default
  const icon = L.divIcon({
    className: 'route-via-marker',
    html: `<span style="display:block;width:13px;height:13px;border-radius:50%;background:#fff;border:3.5px solid ${color};box-shadow:0 1px 4px rgba(0,0,0,0.35);box-sizing:border-box"></span>`,
    iconSize: [13, 13],
    iconAnchor: [6.5, 6.5],
  })
  viaIconCache.set(tone, icon)
  return icon
}

function formatViaDwell(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h > 0 ? `${h} h ${m} min` : `${m} min`
}

/**
 * Create a round photo-circle marker.
 * Shows image_url if available, otherwise category icon in colored circle.
 */
function createPlaceIcon(place, orderNumbers, isSelected) {
  const cacheKey = `${place.id}:${isSelected}:${place.image_url || ''}:${place.category_color || ''}:${place.category_icon || ''}:${orderNumbers?.join(',') || ''}`
  const cached = iconCache.get(cacheKey)
  if (cached) return cached
  const size = isSelected ? 44 : 36
  // Allow-listed, not escaped: the value lands in style="…" of a divIcon, where
  // escaping stops the attribute breakout but still permits a CSS url().
  const borderColor = isSelected ? '#111827' : safeHexColor(place.category_color, 'white')
  const borderWidth = isSelected ? 3 : 2.5
  const shadow = isSelected
    ? '0 0 0 3px rgba(17,24,39,0.25), 0 4px 14px rgba(0,0,0,0.3)'
    : '0 2px 8px rgba(0,0,0,0.22)'
  const bgColor = safeHexColor(place.category_color, '#6b7280')

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
      font-family:var(--font-system);line-height:1;
      box-sizing:border-box;white-space:nowrap;
    ">${label}</span>`
  }

  // Prefer base64 data URLs (no zoom lag); also accept same-origin proxy + uploaded
  // custom images (#1136) as a fallback while the thumb is still being generated
  if (place.image_url && (place.image_url.startsWith('data:') || place.image_url.startsWith('/api/maps/place-photo/') || place.image_url.startsWith('/uploads/'))) {
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
          <img src="${escapeHtml(place.image_url)}" width="${size}" height="${size}" style="display:block;border-radius:50%;object-fit:cover;" />
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

// Small coloured pin for an OSM "explore" POI — distinct from the photo-circle
// markers of planned places; the colour matches its pill category.
const poiIconCache = new Map<string, L.DivIcon>()
function createPoiIcon(category: string) {
  const cached = poiIconCache.get(category)
  if (cached) return cached
  const cat = POI_CATEGORY_BY_KEY[category]
  const color = cat?.color || '#6b7280'
  const svg = cat ? renderIconMarkup(createElement(cat.Icon, { size: 13, color: 'white', strokeWidth: 2.5 })) : ''
  const icon = L.divIcon({
    className: '',
    html: `<div style="width:26px;height:26px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 1px 5px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;cursor:pointer;">${svg}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    tooltipAnchor: [0, -14],
  })
  poiIconCache.set(category, icon)
  return icon
}

// Clears the hover tooltip the moment the camera starts moving and suppresses
// re-showing it until the move ends: after a click-recenter the marker slides
// away under a stationary cursor, so the browser never fires mouseout — and
// mouseover/mousemove during the pan animation would immediately re-set the
// tooltip we just cleared (#1404).
function CameraHoverGuard({ movingRef, onMoveStart }: { movingRef: { current: boolean }; onMoveStart: () => void }) {
  const map = useMap()
  useEffect(() => {
    const start = () => { movingRef.current = true; onMoveStart() }
    const end = () => { movingRef.current = false }
    map.on('movestart zoomstart', start)
    map.on('moveend zoomend', end)
    return () => { map.off('movestart zoomstart', start); map.off('moveend zoomend', end) }
  }, [map, movingRef, onMoveStart])
  return null
}

// Emits the current viewport bbox on pan/zoom so the POI-explore pill can fetch
// OSM places for the visible area.
function ViewportController({ onViewportChange }: { onViewportChange?: (b: { south: number; west: number; north: number; east: number }) => void }) {
  const map = useMap()
  useEffect(() => {
    if (!onViewportChange) return
    const emit = () => {
      const b = map.getBounds()
      onViewportChange({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() })
    }
    map.whenReady(emit) // ensure the first bbox is captured once the map is laid out
    map.on('moveend', emit)
    map.on('zoomend', emit)
    return () => { map.off('moveend', emit); map.off('zoomend', emit) }
  }, [map, onViewportChange])
  return null
}

interface SelectionControllerProps {
  places: Place[]
  selectedPlaceId: number | null
  dayPlaces: Place[]
  paddingOpts: L.FitBoundsOptions
}

function SelectionController({ places, selectedPlaceId, dayPlaces, paddingOpts }: SelectionControllerProps) {
  const map = useMap()
  const prev = useRef(null)

  useEffect(() => {
    if (selectedPlaceId && selectedPlaceId !== prev.current) {
      // Pan to the selected place without changing zoom. Offset the centre by the
      // side-panel + bottom-inspector padding so the pin lands in the middle of the
      // *visible* map area rather than the geometric centre (where the bottom panel
      // would cover it). Reuses the same paddingOpts the fit-bounds path uses.
      const selected = places.find(p => p.id === selectedPlaceId)
      if (selected?.lat != null && selected?.lng != null) {
        const latlng: [number, number] = [selected.lat, selected.lng]
        const tl = paddingOpts.paddingTopLeft as [number, number] | undefined
        const br = paddingOpts.paddingBottomRight as [number, number] | undefined
        if (tl && br && typeof map.project === 'function' && typeof map.unproject === 'function') {
          const point = map.project(latlng).add([(br[0] - tl[0]) / 2, (br[1] - tl[1]) / 2])
          map.panTo(map.unproject(point), { animate: true })
        } else {
          map.panTo(latlng, { animate: true })
        }
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

// Fit bounds when places change (fitKey triggers re-fit). On a day selection we
// fit to that day's destinations immediately, then — once the day's route has
// finished computing asynchronously — re-fit once more to include the full route
// polyline, so a route that bulges past its stops stays in view (#1128).
interface BoundsControllerProps {
  places: Place[]
  routeCoords: [number, number][]
  fitKey: number
  paddingOpts: L.FitBoundsOptions
  /** The map was built already framed on these places, so the opening fit has nothing to do. */
  framedOnMount?: boolean
}

function BoundsController({ places, routeCoords, fitKey, paddingOpts, framedOnMount = false }: BoundsControllerProps) {
  const map = useMap()
  const prevFitKey = useRef(-1)
  const awaitingRoute = useRef(false)
  const fitRan = useRef(false)

  const fitTo = useCallback((coords: [number, number][]) => {
    if (coords.length === 0) return
    try {
      const bounds = L.latLngBounds(coords)
      if (bounds.isValid()) {
        /*
         * The padding already reserves the day panel's height at the bottom
         * (paddingBox), so the fit puts the day's stops above it. There used to
         * be a second, manual nudge 300ms later — panBy([0, 150]) — from the
         * same change that introduced the padding, and the two compensated for
         * the same panel twice.
         *
         * On a route that runs north to south the fit is height-bound, which
         * puts the northernmost stop exactly on the top padding line; the nudge
         * then pushed it off the canvas. The map appeared to frame everything
         * correctly and then drift upwards, which is what the report describes
         * (#1982). MapViewGL never had the nudge, so this also brings the two
         * renderers back into agreement.
         */
        map.fitBounds(bounds, { ...paddingOpts, maxZoom: 16, animate: true })
      }
    } catch {}
  }, [map, paddingOpts])

  // New fitKey (initial trip fit or a day selection): fit to the destinations now
  // and arm a one-shot re-fit for when the route arrives.
  useEffect(() => {
    if (fitKey === prevFitKey.current) return
    prevFitKey.current = fitKey
    awaitingRoute.current = false
    if (places.length === 0) return
    // The map opened framed on these very places — re-fitting would only re-do that, and its
    // maxZoom would overrule the gentler zoom a single place opens at. Later fits (picking a
    // day) still run.
    if (!fitRan.current && framedOnMount) {
      fitRan.current = true
      return
    }
    fitRan.current = true
    fitTo(places.map(p => [p.lat, p.lng] as [number, number]))
    awaitingRoute.current = true
  }, [fitKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Once the just-selected day's route is ready, expand the fit to include it.
  // One-shot per day-fit, so later route-profile toggles don't re-zoom the map.
  useEffect(() => {
    if (!awaitingRoute.current || routeCoords.length === 0) return
    awaitingRoute.current = false
    fitTo([...places.map(p => [p.lat, p.lng] as [number, number]), ...routeCoords])
  }, [routeCoords]) // eslint-disable-line react-hooks/exhaustive-deps

  return null
}

interface MapClickHandlerProps {
  onClick: ((e: L.LeafletMouseEvent) => void) | null
}

const TRACK_CASING_PANE = 'trek-track-casing'

/**
 * Pane that holds the white casing under GPX tracks (#776). Leaflet stacks paths
 * in insertion order, so without a pane of its own a casing mounted later — a
 * newly imported track, or one that just got a colour — would paint over an
 * earlier track's line. Pane support is an optimization: a renderer without the
 * pane API still draws everything, just in insertion order.
 */
function TrackCasingPane({ onReady }: { onReady: (ready: boolean) => void }) {
  const map = useMap()
  useEffect(() => {
    if (typeof map.getPane !== 'function' || typeof map.createPane !== 'function') return
    if (!map.getPane(TRACK_CASING_PANE)) {
      const pane = map.createPane(TRACK_CASING_PANE)
      if (pane) pane.style.zIndex = '398' // under overlayPane (400) and the plugin pane (399)
    }
    onReady(true)
  }, [map, onReady])
  return null
}

function MapClickHandler({ onClick }: MapClickHandlerProps) {
  const map = useMap()
  useEffect(() => {
    if (!onClick) return
    map.on('click', onClick)
    return () => { map.off('click', onClick) }
  }, [map, onClick])
  return null
}

function MapContextMenuHandler({ onContextMenu }: { onContextMenu: ((e: L.LeafletMouseEvent) => void) | null }) {
  const map = useMap()
  useEffect(() => {
    if (!onContextMenu) return
    map.on('contextmenu', onContextMenu)
    return () => { map.off('contextmenu', onContextMenu) }
  }, [map, onContextMenu])
  return null
}

// Travel times are shown in the day sidebar (per-segment connectors), not on the map.

// Module-level photo cache shared with PlaceAvatar
import { getCached, isLoading, fetchPhoto, onThumbReady, getAllThumbs } from '../../services/photoService'
import { isCustomPlaceImage, photoCacheKey } from './placePhoto'
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
  /** Off in read-only trips and on the phone, where HTML5 drag does not exist. */
  draggable: boolean
}

const MemoMarker = memo(function MemoMarker({
  place, isSelected, orderNumbers, photoUrl, onClickPlace, onHover, onHoverOut, draggable,
}: MemoMarkerProps) {
  const icon = createPlaceIcon({ ...place, image_url: photoUrl }, orderNumbers, isSelected)
  const cleanupRef = useRef<(() => void) | null>(null)
  return (
    <Marker
      position={[place.lat, place.lng]}
      icon={icon}
      eventHandlers={{
        // The element only exists once Leaflet has put the marker on the map,
        // and it is rebuilt whenever the icon changes (selection, day number),
        // so the wiring is redone on every add rather than once on mount.
        add: (e: any) => {
          cleanupRef.current?.()
          cleanupRef.current = draggable ? makeMarkerDraggable(e.target.getElement() as HTMLElement, place.id) : null
        },
        remove: () => { cleanupRef.current?.(); cleanupRef.current = null },
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
  hoverDisabled = false,
  onMarkerClick,
  onMapClick,
  onMapContextMenu = null,
  center = DEFAULT_MAP_CENTER,
  zoom = DEFAULT_MAP_ZOOM,
  // Callers hand down a URL that already carries the CARTO key; this is only
  // the shape a caller without one gets.
  tileUrl = OFM_POSITRON,
  fitKey = 0,
  dayOrderMap = {},
  leftWidth = 0,
  rightWidth = 0,
  hasInspector = false,
  hasDayDetail = false,
  reservations = [] as Reservation[],
  showReservationStats = false,
  visibleConnectionIds = [] as number[],
  showTransitRoutes = true,
  days = [] as Day[],
  selectedDayId = null,
  onReservationClick,
  pois = [] as Poi[],
  onPoiClick,
  onViewportChange,
  tripId,
  routeVias = [],
}: any) {
  // The caller hands over whatever the user configured; what kind of basemap
  // that is decides which layer draws it. A saved raster template still wins,
  // the default is a vector style.
  const basemap = useMemo(() => resolveBasemap(tileUrl, OFM_POSITRON), [tileUrl])
  /**
   * Amap's tiles are drawn in GCJ-02 (see gcj02Crs.ts). The projection has to be
   * decided before the map is constructed, because Leaflet cannot change a map's
   * CRS afterwards — hence the whole map, not just the tile layer.
   */
  const isGcjBasemap = basemap.kind === 'raster' && isGcj02Basemap(basemap.url)
  const gcjCrs = useMemo(() => crsForBasemap(isGcjBasemap), [isGcjBasemap])
  const poiMarkers = useMemo(() => (pois as Poi[]).map((poi: Poi) => (
    <Marker
      key={`poi-${poi.osm_id}`}
      position={[poi.lat, poi.lng]}
      icon={createPoiIcon(poi.category)}
      zIndexOffset={500}
      eventHandlers={{ click: () => onPoiClick?.(poi) }}
    >
      <Tooltip direction="top" offset={[0, -10]} opacity={1} className="map-tooltip">{poi.name}</Tooltip>
    </Marker>
  )), [pois, onPoiClick])
  const visibleReservations = useMemo(() => (
    visibleRouteReservations(reservations, { visibleConnectionIds, showTransitRoutes, selectedDayId, days })
  ), [reservations, visibleConnectionIds, showTransitRoutes, selectedDayId, days])
  // Real road geometry for car/bus/taxi/bicycle bookings (straight line until it loads/if it fails).
  const transportRoutes = useTransportRoutes(visibleReservations)
  // Dynamic padding: account for sidebars + bottom inspector + day detail panel
  // The chrome overlaying the map (side panels, day detail). Kept as a plain box so both the
  // Leaflet fit options and the opening-camera maths can read the same numbers.
  const paddingBox = useMemo((): ViewportPadding => {
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
    if (isMobile) return { top: 20, right: 40, bottom: 20, left: 40 }
    return {
      top: 60,
      right: rightWidth + 40,
      bottom: hasInspector ? 320 : hasDayDetail ? 280 : 60,
      left: leftWidth + 40,
    }
  }, [leftWidth, rightWidth, hasInspector, hasDayDetail])

  const paddingOpts = useMemo((): L.FitBoundsOptions => ({
    paddingTopLeft: [paddingBox.left, paddingBox.top],
    paddingBottomRight: [paddingBox.right, paddingBox.bottom],
  }), [paddingBox])

  // Open framed on the places rather than on the caller's default, so a trip in Japan shows
  // Japan straight away instead of the world view followed by a flight across the planet.
  // The initializer runs once, at mount — exactly when this should be decided; afterwards the
  // camera belongs to the user. `framed` is false when no place has coordinates (a new trip),
  // and then the caller's center/zoom stands.
  const [initialView] = useState(() => {
    const framed = computeMapViewport(dayPlaces.length > 0 ? dayPlaces : places, {
      tileSize: TILE_SIZE_RASTER,
      padding: paddingBox,
    })
    return { center: framed?.center ?? center, zoom: framed?.zoom ?? zoom, framed: framed !== null }
  })

  // Hover state for the single tooltip overlay (replaces per-marker <Tooltip>)
  const [hoveredPlace, setHoveredPlace] = useState<any>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const mapMovingRef = useRef(false)

  const handleMarkerHover = useCallback((place: any, x: number, y: number) => {
    if (hoverDisabled || mapMovingRef.current) return
    setHoveredPlace(place)
    setTooltipPos({ x, y })
  }, [hoverDisabled])

  const handleMarkerHoverOut = useCallback(() => {
    setHoveredPlace(null)
    setTooltipPos(null)
  }, [])

  // A marker's DOM node is replaced when it becomes selected (its icon grows
  // 36→44px, and the cluster group re-adds it), so the browser never fires
  // mouseout on the old node and the fixed-position hover tooltip gets orphaned
  // — it hangs on screen and drifts with page scroll. Drop it on any selection
  // change and on any scroll so it can never get stuck.
  useEffect(() => { setHoveredPlace(null); setTooltipPos(null) }, [selectedPlaceId])
  useEffect(() => {
    if (!hoveredPlace) return
    const clear = () => { setHoveredPlace(null); setTooltipPos(null) }
    window.addEventListener('scroll', clear, true)
    return () => window.removeEventListener('scroll', clear, true)
  }, [hoveredPlace])

  const [hasCasingPane, setHasCasingPane] = useState(false)

  const handleMarkerClick = useCallback((id: number) => {
    // Clear the hover card right away: the recenter that follows moves the
    // marker out from under the cursor, so no mouseout will ever fire (#1404).
    setHoveredPlace(null)
    setTooltipPos(null)
    onMarkerClick?.(id)
  }, [onMarkerClick])

  const clearHover = useCallback(() => {
    setHoveredPlace(null)
    setTooltipPos(null)
  }, [])

  // photoUrls: only base64 thumbs for smooth map zoom
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>(getAllThumbs)
  const placesPhotosEnabled = useAuthStore(s => s.placesPhotosEnabled)
  // Batch photo state updates through a RAF so N simultaneous photo loads
  // collapse into a single re-render instead of N separate renders.
  const pendingThumbsRef = useRef<Record<string, string>>({})
  const thumbRafRef = useRef<number | null>(null)

  const placeIds = useMemo(() => places.map(p => p.id).join(','), [places])
  // Flattened [lat,lng] points of the selected day's route, so the bounds fit can
  // include the full polyline once it has been computed.
  const routeCoords = useMemo<[number, number][]>(() => (route || []).flat() as [number, number][], [route])
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
      // A custom uploaded image is shown directly — never auto-fetch a provider
      // photo for it (the request would 404 for OSM-only places and the fetched
      // thumb would shadow the user's own image). (#1136)
      if (isCustomPlaceImage(place.image_url)) continue
      const cacheKey = photoCacheKey(place)
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
  // Drag a marker onto a day (#891). Pointer-driven, so it is off wherever
  // HTML5 drag does not exist — and the day plan is not on screen there anyway.
  const markersDraggable = !isTouchDevice

  const markers = useMemo(() => places.map((place) => {
    const isSelected = place.id === selectedPlaceId
    const pck = photoCacheKey(place)
    // A custom uploaded image wins over the auto-fetched thumb; otherwise fall back.
    const photoUrl = isCustomPlaceImage(place.image_url) ? place.image_url! : ((pck && photoUrls[pck]) || place.image_url || null)
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
        draggable={markersDraggable}
      />
    )
  }), [places, selectedPlaceId, dayOrderMap, photoUrls, handleMarkerClick, handleMarkerHover, handleMarkerHoverOut, markersDraggable])

  // Parsing track geometry is the expensive part (tracks run to tens of thousands
  // of points), so it hangs off `places` alone — a selection change must not
  // re-parse every track.
  const gpxTracks = useMemo(() => places.flatMap(place => {
    if (!place.route_geometry) return []
    try {
      const coords = JSON.parse(place.route_geometry) as [number, number][]
      if (!coords || coords.length < 2) return []
      return [{ place, coords, cased: hasManualTrackColor(place), color: resolveTrackColor(place) }]
    } catch { return [] }
  }), [places])

  // Keeps the click handler out of the polyline memo below: `handleMarkerClick`
  // changes on every selection, and depending on it would redraw all tracks.
  const markerClickRef = useRef(handleMarkerClick)
  markerClickRef.current = handleMarkerClick

  const gpxPolylines = useMemo(() => (
    <>
      {/* Casings live in their own pane below the lines. Leaflet stacks paths by
          insertion order, so drawing them inline would put the casing of a track
          added later — or of one just given a colour — on top of an earlier
          track's line. Always rendered, hidden via opacity when there is no
          colour, so toggling one never remounts the path. */}
      {gpxTracks.map(({ place, coords, cased }) => (
        <Polyline
          key={`gpx-${place.id}-casing`}
          positions={coords}
          pane={hasCasingPane ? TRACK_CASING_PANE : undefined}
          pathOptions={{ color: '#ffffff', weight: 6.5, opacity: cased ? 0.7 : 0, lineCap: 'round', lineJoin: 'round' }}
          interactive={false}
        />
      ))}
      {/* pathOptions, not bare color/weight props: react-leaflet only calls
          setStyle when the pathOptions reference changes, so bare props would
          stick at their mount-time colour and a repaint would never arrive. */}
      {gpxTracks.map(({ place, coords, cased, color }) => (
        <Polyline
          key={`gpx-${place.id}`}
          positions={coords}
          pathOptions={{ color, weight: 3.5, opacity: cased ? 0.9 : 0.75 }}
          interactive={false}
        />
      ))}
      {/* Invisible fat line on top so the track can actually be hit — 3.5px is
          not a target, least of all on touch, and the start markers cluster below
          zoom 11. bubblingMouseEvents is essential: paths bubble to the map by
          default (markers do not), and the map's own click handler clears the
          selection this one just made. */}
      {gpxTracks.map(({ place, coords }) => (
        <Polyline
          key={`gpx-${place.id}-hit`}
          positions={coords}
          pathOptions={{ color: '#000', weight: 14, opacity: 0, lineCap: 'round', lineJoin: 'round' }}
          bubblingMouseEvents={false}
          eventHandlers={{ click: () => markerClickRef.current(place.id) }}
        />
      ))}
    </>
  ), [gpxTracks, hasCasingPane])

  const TooltipOverlay = !hoverDisabled && hoveredPlace && tooltipPos && !isTouchDevice
  const CatIcon = TooltipOverlay ? getCategoryIcon(hoveredPlace.category_icon) : null

  const { position: userPosition, mode: trackingMode, error: trackingError, errorCode: trackingErrorCode, cycleMode: cycleTrackingMode } = useGeolocation()
  // Desktop browsers only get IP-based geolocation (city-level accuracy),
  // so the button would be misleading. Mobile, where real GPS lives, keeps it.
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  // When the day-detail panel is open it slides up over the map (bottom: navh+20,
  // height var(--day-panel-h)) and covers the button's band, so lift the button
  // above it; otherwise keep the plain bottom-nav offset. #1348
  const locationButtonBottom = hasDayDetail
    ? 'calc(var(--bottom-nav-h, 84px) + 20px + var(--day-panel-h, 0px) + 12px)'
    : 'calc(var(--bottom-nav-h, 84px) + 12px)'

  const baseLayer = useSettingsStore(s => s.settings.map_base_layer) || 'default'
  const updateSetting = useSettingsStore(s => s.updateSetting)
  const isSatellite = baseLayer === 'satellite'
  const toggleBaseLayer = useCallback(() => {
    // Store flips state synchronously (instant, works offline); a failed save is logged there.
    updateSetting('map_base_layer', isSatellite ? 'default' : 'satellite').catch(() => {})
  }, [isSatellite, updateSetting])
  const switcherBottom = hasDayDetail
    ? 'calc(var(--bottom-nav-h, 0px) + 20px + var(--day-panel-h, 0px) + 12px)'
    : 'calc(var(--bottom-nav-h, 0px) + 12px)'

  return (
    <>
    <div className="w-full h-full relative">
    <MapContainer
      id="trek-map"
      center={initialView.center}
      zoom={initialView.zoom}
      zoomControl={false}
      // On the map itself, not left to the base layer. Leaflet reads its zoom
      // ceiling from the map options or, failing that, from a GridLayer that
      // brought one; a vector basemap is neither, so a map drawn by
      // VectorBasemap had no ceiling at all. MarkerClusterGroup.onAdd throws
      // outright on an infinite one, which took the whole planner down.
      maxZoom={MAP_MAX_ZOOM}
      // Omitted entirely for a WGS-84 basemap, which is every install that has
      // not chosen Amap: passing L.CRS.EPSG3857 explicitly would be the same
      // value, but leaving the prop off keeps those maps byte-identical.
      {...(gcjCrs ? { crs: gcjCrs } : {})}
      className="w-full h-full bg-[#e5e7eb]"
    >
      {/* The basemap is a vector style by default and a raster template when the
          user brought their own, so the two are drawn by different things. The
          satellite toggle is always raster.
          key remounts the raster layer on switch, else attribution/maxZoom stick
          at mount-time values. */}
      {isSatellite ? (
        <TileLayer
          key="satellite"
          // Esri's imagery is WGS-84 and Amap's is GCJ-02, and the map's CRS is
          // already fixed by the basemap the user chose. Handing the other datum
          // to that projection moves the whole photo a few hundred metres, so the
          // satellite toggle follows the datum rather than always meaning Esri.
          url={isGcjBasemap ? AMAP_SATELLITE : SATELLITE_TILE_URL}
          attribution={attributionForTile(isGcjBasemap ? AMAP_SATELLITE : SATELLITE_TILE_URL)}
          maxZoom={SATELLITE_TILE_MAXZOOM}
          keepBuffer={8}
          updateWhenZooming={false}
          updateWhenIdle={true}
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : basemap.kind === 'vector' ? (
        <VectorBasemap style={basemap.style} />
      ) : (
        <TileLayer
          key="raster"
          url={basemap.url}
          attribution={attributionForTile(basemap.url)}
          maxZoom={19}
          keepBuffer={8}
          updateWhenZooming={false}
          updateWhenIdle={true}
          referrerPolicy="strict-origin-when-cross-origin"
        />
      )}

      <MapController center={center} zoom={zoom} />
      <BoundsController places={dayPlaces.length > 0 ? dayPlaces : places} routeCoords={dayPlaces.length > 0 ? routeCoords : []} fitKey={fitKey} paddingOpts={paddingOpts} framedOnMount={initialView.framed} />
      <SelectionController places={places} selectedPlaceId={selectedPlaceId} dayPlaces={dayPlaces} paddingOpts={paddingOpts} />
      <MapClickHandler onClick={onMapClick} />
      <MapContextMenuHandler onContextMenu={onMapContextMenu} />
      <CameraHoverGuard movingRef={mapMovingRef} onMoveStart={clearHover} />
      <ViewportController onViewportChange={onViewportChange} />
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

      {/* Apple-Maps style: darker-blue casing under a bright-blue core, rounded. */}
      {route && route.length > 0 && route.flatMap((seg, i) => seg.length > 1 ? [
        <Polyline
          key={`${i}-casing`}
          positions={seg}
          pathOptions={{ color: '#0a5cc2', weight: 8, opacity: 1, lineCap: 'round', lineJoin: 'round' }}
        />,
        <Polyline
          key={`${i}-core`}
          positions={seg}
          pathOptions={{ color: '#0a84ff', weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round' }}
        />,
      ] : [])}

      {/* GPX imported route geometries */}
      <TrackCasingPane onReady={setHasCasingPane} />
      {gpxPolylines}

      <ReservationOverlay
        reservations={visibleReservations}
        showConnections
        showStats={showReservationStats}
        onEndpointClick={onReservationClick}
        roadRoutes={transportRoutes}
      />

      {poiMarkers}
      {/* Charging stops / rest areas a plugin route places on the drawn day route.
          Host-vetted data (server-normalized), rendered as plain tone dots. */}
      {(routeVias as RouteVia[]).map((v, i) => (
        <Marker key={`route-via-${i}`} position={[v.lat, v.lng]} icon={routeViaIcon(v.tone)} zIndexOffset={800}>
          {(v.label || v.dwellSeconds != null) && (
            <Tooltip direction="top" offset={[0, -8]}>
              {v.label}
              {v.label && v.dwellSeconds != null ? ' · ' : ''}
              {v.dwellSeconds != null ? formatViaDwell(v.dwellSeconds) : ''}
            </Tooltip>
          )}
        </Marker>
      ))}
      <PluginMapMarkers tripId={tripId} />
      <PluginMapLayers tripId={tripId} />
    </MapContainer>
    {isMobile && <LocationButton
      mode={trackingMode}
      error={trackingError}
      errorCode={trackingErrorCode}
      onClick={cycleTrackingMode}
      bottomOffset={locationButtonBottom as unknown as number}
    />}
    {/* 20px off the sidebar, not 12: the pill is round and frosted, so at the
        smaller gap its shadow ran into the sidebar edge and the two read as one
        surface. */}
    <div style={{ position: 'absolute', left: leftWidth + 20, bottom: switcherBottom, zIndex: 1000, pointerEvents: 'none' }}>
      <MapLayerSwitcher active={baseLayer} onToggle={toggleBaseLayer} />
    </div>
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
        fontFamily: "var(--font-system)",
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
