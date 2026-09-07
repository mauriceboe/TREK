import React, { useState, useEffect, useMemo, useRef, Suspense } from 'react'
import { Map, Save, Layers, Box, ChevronDown, Check, Globe2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../store/settingsStore'
import { useToast } from '../shared/Toast'
import CustomSelect from '../shared/CustomSelect'
import { MapView } from '../Map/MapView'
// The preview loads on demand, and paired with a single engine — a Leaflet-only
// install pays for neither, and a GL install pays for one instead of both.
import ErrorBoundary from '../shared/ErrorBoundary'
import { GlMapPreviewMapbox, GlMapPreviewMaplibre } from '../Map/glLazy'
import Section from './Section'
import ToggleSwitch from './ToggleSwitch'
import { withTileApiKey } from '../../utils/tileUrl'
import { AMAP_ROAD, AMAP_SATELLITE } from '../../constants/mapDefaults'
import type { Place } from '../../types'
import {
  MAPBOX_DEFAULT_STYLE,
  defaultStyleForProvider,
  getStylePresets,
  isOpenFreeMapStyle,
  normalizeStyleForProvider,
  type GlMapProvider,
} from '../Map/glProviders'
import { useAuthStore } from '../../store/authStore'

interface MapPreset {
  name: string
  url: string
}

const MAP_PRESETS: MapPreset[] = [
  { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },
  { name: 'OpenStreetMap DE', url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png' },
  // The app default, and a vector style rather than a {z}/{x}/{y} template: no
  // key, no registration, no request limits.
  { name: 'OpenFreeMap Positron', url: 'https://tiles.openfreemap.org/styles/positron' },
  { name: 'OpenFreeMap Bright', url: 'https://tiles.openfreemap.org/styles/bright' },
  // CARTO watermarks keyless tiles since 26.08.2026 and issues keys by mail, so
  // these two need one; without it the map falls back to the default (#2054).
  { name: 'CartoDB Light', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' },
  { name: 'CartoDB Dark', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png' },
  { name: 'Stadia Smooth', url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png' },
  // Amap (高德). GCJ-02 tiles — the map switches to a shifted projection for
  // these so markers still land on the right street (see gcj02Crs.ts). The only
  // basemap here that is genuinely good inside mainland China.
  { name: '高德地图 (Amap)', url: AMAP_ROAD },
  { name: '高德卫星 (Amap Satellite)', url: AMAP_SATELLITE },
]

// Tag → chip color mapping. Keeps the dropdown readable at a glance so a
// user scanning the list can spot 3D / Satellite / Apple-like styles.
const TAG_STYLES: Record<string, string> = {
  '3D': 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
  '2D': 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  'Satellite': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  'Apple-like': 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  'Modern': 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  'Dark': 'bg-zinc-800 text-zinc-100 dark:bg-zinc-900 dark:text-zinc-300',
  'Minimal': 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  'Hillshading': 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  'Terrain': 'bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-300',
  'Realistic': 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
  'Navigation': 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  'Classic': 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
  'Hybrid': 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300',
  'No labels': 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  'OpenFreeMap': 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
}

function TagChip({ tag }: { tag: string }) {
  const cls = TAG_STYLES[tag] || 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
  return (
    <span className={`text-[9px] font-semibold tracking-wide uppercase px-1.5 py-[3px] rounded leading-none ${cls}`}>
      {tag}
    </span>
  )
}

function StyleDropdown({ value, provider, onChange }: { value: string; provider: GlMapProvider; onChange: (v: string) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const presets = getStylePresets(provider)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const selected = presets.find(p => p.url === value)
  const placeholder = provider === 'maplibre-gl'
    ? t('settings.mapOpenFreeMapStylePlaceholder')
    : t('settings.mapStylePlaceholder')

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-900 hover:border-slate-400 focus:ring-2 focus:ring-slate-400 focus:border-transparent"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-slate-900 dark:text-white truncate">
            {selected ? selected.name : placeholder}
          </span>
          {selected && (
            <span className="flex items-center gap-1 flex-shrink-0">
              {(selected.tags || []).map(t => <TagChip key={t} tag={t} />)}
            </span>
          )}
        </span>
        <ChevronDown size={14} className="flex-shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-80 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg py-1">
          {presets.map(preset => {
            const isActive = preset.url === value
            return (
              <button
                key={preset.url}
                type="button"
                onClick={() => { onChange(preset.url); setOpen(false) }}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800 ${isActive ? 'bg-slate-50 dark:bg-slate-800' : ''}`}
              >
                <span className="flex items-center gap-2 flex-wrap">
                  <span className="text-slate-900 dark:text-white font-medium">{preset.name}</span>
                  {(preset.tags || []).map(t => <TagChip key={t} tag={t} />)}
                </span>
                {isActive && <Check size={14} className="flex-shrink-0 text-slate-900 dark:text-white" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

type Provider = 'leaflet' | GlMapProvider

function normalizeProvider(value: unknown): Provider {
  return value === 'mapbox-gl' || value === 'maplibre-gl' ? value : 'leaflet'
}

function styleForProvider(provider: Provider, style?: string | null): string {
  if (provider === 'leaflet') return style || MAPBOX_DEFAULT_STYLE
  if (provider === 'mapbox-gl' && isOpenFreeMapStyle(style)) return MAPBOX_DEFAULT_STYLE
  return normalizeStyleForProvider(provider, style)
}

// Each GL provider has its own style slot, so toggling providers never clobbers the
// other one's style. Leaflet/Mapbox use mapbox_style; MapLibre uses maplibre_style.
function slotStyle(provider: Provider, s: { mapbox_style?: string; maplibre_style?: string }): string | undefined {
  return provider === 'maplibre-gl' ? s.maplibre_style : s.mapbox_style
}

/**
 * Somewhere recognisable for the style preview to render. A city shows off label density,
 * 3D buildings and satellite texture in a way open ocean cannot — it is not a user setting,
 * and no map opens here: each map frames itself on its own places.
 */
const PREVIEW_CENTER: [number, number] = [48.8566, 2.3522]
const PREVIEW_ZOOM = 16

export default function MapSettingsTab(): React.ReactElement {
  const { settings, updateSettings } = useSettingsStore()
  const { t } = useTranslation()
  const toast = useToast()
  const initialProvider = normalizeProvider(settings.map_provider)
  const [saving, setSaving] = useState(false)
  const [provider, setProvider] = useState<Provider>(initialProvider)
  const [mapTileUrl, setMapTileUrl] = useState<string>(settings.map_tile_url || '')
  const managed = useAuthStore((s) => s.managed)
  const [mapboxToken, setMapboxToken] = useState<string>(settings.mapbox_access_token || '')
  const [cartoKey, setCartoKey] = useState<string>(settings.carto_api_key || '')
  const [mapboxStyle, setMapboxStyle] = useState<string>(styleForProvider(initialProvider, slotStyle(initialProvider, settings)))
  const [mapbox3d, setMapbox3d] = useState<boolean>(settings.mapbox_3d_enabled !== false)
  const [mapboxQuality, setMapboxQuality] = useState<boolean>(settings.mapbox_quality_mode === true)
  // One chunk per engine — see components/Map/glLazy.tsx.
  const GlMapPreview = provider === 'maplibre-gl' ? GlMapPreviewMaplibre : GlMapPreviewMapbox

  useEffect(() => {
    const nextProvider = normalizeProvider(settings.map_provider)
    setProvider(nextProvider)
    setMapTileUrl(settings.map_tile_url || '')
    setMapboxToken(settings.mapbox_access_token || '')
    setCartoKey(settings.carto_api_key || '')
    setMapboxStyle(styleForProvider(nextProvider, slotStyle(nextProvider, settings)))
    setMapbox3d(settings.mapbox_3d_enabled !== false)
    setMapboxQuality(settings.mapbox_quality_mode === true)
  }, [settings])

  const previewPlaces = useMemo((): Place[] => [{
    id: 1,
    trip_id: 1,
    name: 'Preview',
    description: '',
    lat: PREVIEW_CENTER[0],
    lng: PREVIEW_CENTER[1],
    address: '',
    category_id: 0,
    price: null,
    image_url: null,
    google_place_id: null,
    osm_id: null,
    route_geometry: null,
    place_time: null,
    end_time: null,
    created_at: String(new Date()),
  }], [])

  const saveMapSettings = async (): Promise<void> => {
    setSaving(true)
    try {
      const glStyle = provider === 'leaflet' ? mapboxStyle : normalizeStyleForProvider(provider, mapboxStyle)
      // Save into the active provider's own slot so the other provider's style survives.
      const stylePatch = provider === 'maplibre-gl' ? { maplibre_style: glStyle } : { mapbox_style: glStyle }
      await updateSettings({
        map_provider: provider,
        map_tile_url: mapTileUrl,
        mapbox_access_token: mapboxToken,
        carto_api_key: cartoKey,
        ...stylePatch,
        mapbox_3d_enabled: mapbox3d,
        mapbox_quality_mode: mapboxQuality,
      })
      // Only mirror the normalized style into the form once it is actually persisted.
      setMapboxStyle(glStyle)
      toast.success(t('settings.toast.mapSaved'))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  // 3D is available on every style now — pure satellite uses the
  // mapbox-streets-v8 tileset as a fallback building source.
  const supports3d = true
  const changeProvider = (nextProvider: Provider) => {
    setProvider(nextProvider)
    if (nextProvider !== 'leaflet') setMapboxStyle(styleForProvider(nextProvider, mapboxStyle))
  }
  // Only CARTO burns a watermark into keyless tiles, so the nudge is scoped to its hosts.
  const cartoNeedsKey = mapTileUrl.includes('basemaps.cartocdn.com') && !cartoKey.trim()

  return (
    <Section title={t('settings.map')} icon={Map}>
      {/* Provider picker — big cards so the choice is obvious */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-2">{t('settings.mapProvider')}</label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => changeProvider('leaflet')}
            className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-colors ${
              provider === 'leaflet'
                ? 'border-slate-900 bg-slate-50 dark:bg-slate-800 dark:border-slate-200'
                : 'border-slate-200 hover:border-slate-400 dark:border-slate-700'
            }`}
          >
            <Layers size={18} className="mt-0.5 flex-shrink-0 text-slate-700 dark:text-slate-300" />
            <div>
              <div className="text-sm font-medium text-slate-900 dark:text-white">Leaflet</div>
              <div className="hidden sm:block text-xs text-slate-500 mt-0.5">{t('settings.mapLeafletSubtitle')}</div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => changeProvider('mapbox-gl')}
            className={`relative flex items-start gap-3 p-3 rounded-lg border text-left transition-colors ${
              provider === 'mapbox-gl'
                ? 'border-slate-900 bg-slate-50 dark:bg-slate-800 dark:border-slate-200'
                : 'border-slate-200 hover:border-slate-400 dark:border-slate-700'
            }`}
          >
            <Box size={18} className="mt-0.5 flex-shrink-0 text-slate-700 dark:text-slate-300" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900 dark:text-white">
                <span className="sm:hidden">Mapbox</span>
                <span className="hidden sm:inline">Mapbox GL</span>
              </div>
              <div className="hidden sm:block text-xs text-slate-500 mt-0.5">{t('settings.mapMapboxSubtitle')}</div>
            </div>
            {/* Experimental badge only on ≥sm; on mobile there's no room next to the title. */}
            <span className="hidden sm:inline-block absolute top-2 right-2 text-[9px] font-semibold tracking-wide uppercase px-1.5 py-[3px] rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 leading-none">
              {t('settings.mapExperimental')}
            </span>
          </button>
          <button
            type="button"
            onClick={() => changeProvider('maplibre-gl')}
            className={`relative flex items-start gap-3 p-3 rounded-lg border text-left transition-colors ${
              provider === 'maplibre-gl'
                ? 'border-slate-900 bg-slate-50 dark:bg-slate-800 dark:border-slate-200'
                : 'border-slate-200 hover:border-slate-400 dark:border-slate-700'
            }`}
          >
            <Globe2 size={18} className="mt-0.5 flex-shrink-0 text-slate-700 dark:text-slate-300" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900 dark:text-white">
                <span className="sm:hidden">MapLibre</span>
                <span className="hidden sm:inline">MapLibre GL</span>
              </div>
              <div className="hidden sm:block text-xs text-slate-500 mt-0.5">{t('settings.mapMapLibreSubtitle')}</div>
            </div>
          </button>
        </div>
        <p className="text-xs text-slate-400 mt-2">
          {t('settings.mapProviderHint')}
        </p>
      </div>

      {/* Leaflet settings */}
      {provider === 'leaflet' && (
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.mapTemplate')}</label>
          <CustomSelect
            value={mapTileUrl}
            onChange={(value: string) => { if (value) setMapTileUrl(value) }}
            placeholder={t('settings.mapTemplatePlaceholder.select')}
            options={MAP_PRESETS.map(p => ({ value: p.url, label: p.name }))}
            size="sm"
            style={{ marginBottom: 8 }}
          />
          <input
            type="text"
            value={mapTileUrl}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMapTileUrl(e.target.value)}
            placeholder="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
          />
          <p className="text-xs text-slate-400 mt-1">{t('settings.mapDefaultHint')}</p>
        </div>
      )}

      {/* Same deal as the Mapbox token: a managed install brings its own key. */}
      {provider === 'leaflet' && !managed && (
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.mapCartoKey')}</label>
          <input
            type="text"
            value={cartoKey}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCartoKey(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-slate-400 focus:border-transparent"
          />
          <p className="text-xs text-slate-400 mt-1">
            {t('settings.mapCartoKeyHint')}{' '}
            <a href="https://carto.com/basemaps/apikey/" target="_blank" rel="noreferrer" className="underline">
              {t('settings.mapCartoKeyLink')}
            </a>
          </p>
          {cartoNeedsKey && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">{t('settings.mapCartoKeyMissing')}</p>
          )}
        </div>
      )}

      {/* GL settings */}
      {provider !== 'leaflet' && (
        <div className="space-y-3">
          {/* The token comes with the instance on a managed install, injected when the
              settings are read. A field here would only let somebody save a worse one. */}
          {provider === 'mapbox-gl' && !managed && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.mapMapboxToken')}</label>
            <input
              type="text"
              value={mapboxToken}
              onChange={(e) => setMapboxToken(e.target.value)}
              placeholder="pk.eyJ1Ijoi..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-slate-400 focus:border-transparent"
            />
            <p className="text-xs text-slate-400 mt-1">
              {t('settings.mapMapboxTokenHint')}{' '}
              <a href="https://account.mapbox.com/access-tokens/" target="_blank" rel="noreferrer" className="underline">
                {t('settings.mapMapboxTokenLink')}
              </a>
            </p>
          </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.mapStyle')}</label>
            <div className="mb-2">
              <StyleDropdown value={mapboxStyle} provider={provider} onChange={setMapboxStyle} />
            </div>
            <input
              type="text"
              value={mapboxStyle}
              onChange={(e) => setMapboxStyle(e.target.value)}
              placeholder={defaultStyleForProvider(provider)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-slate-400 focus:border-transparent"
            />
            <p className="text-xs text-slate-400 mt-1">
              {provider === 'maplibre-gl' ? t('settings.mapOpenFreeMapStyleHint') : t('settings.mapStyleHint')}
            </p>
          </div>

          {provider === 'mapbox-gl' && (
          <>
          <div className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
            supports3d
              ? 'border-slate-200 dark:border-slate-700'
              : 'border-slate-200 opacity-60 dark:border-slate-700'
          }`}>
            <div className="flex-1">
              <div className="text-sm font-medium text-slate-900 dark:text-white">{t('settings.map3dBuildings')}</div>
              <div className="text-xs text-slate-500 mt-0.5">
                {t('settings.map3dHint')}
              </div>
            </div>
            <ToggleSwitch
              on={mapbox3d && supports3d}
              onToggle={() => { if (supports3d) setMapbox3d(!mapbox3d) }}
            />
          </div>

          <div className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
            <div className="flex-1">
              <div className="text-sm font-medium text-slate-900 dark:text-white flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
                <span className="order-2 sm:order-1">{t('settings.mapHighQuality')}</span>
                <span className="order-1 sm:order-2 text-[9px] font-semibold tracking-wide uppercase px-1.5 py-[3px] rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 leading-none">
                  {t('settings.mapExperimental')}
                </span>
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                {t('settings.mapHighQualityHint')}{' '}
                <span className="text-amber-600 dark:text-amber-400">{t('settings.mapHighQualityWarning')}</span>
              </div>
            </div>
            <ToggleSwitch on={mapboxQuality} onToggle={() => setMapboxQuality(!mapboxQuality)} />
          </div>

          <div className="text-xs text-slate-400 p-3 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
            <strong className="text-slate-600 dark:text-slate-300">{t('settings.mapTipLabel')}</strong> {t('settings.mapTip')}
          </div>
          </>
          )}
        </div>
      )}

      <div>
        <div style={{ position: 'relative', inset: 0, height: '200px', width: '100%' }}>
          {provider !== 'leaflet' ? (
            /* A net of its own: the preview is the one place a user flips providers
               live, so it is the likeliest chunk to fail — and a broken preview must
               not take the rest of the settings tab with it. */
            <ErrorBoundary boundaryId="settings:map-preview" resetKeys={[provider]} fallback={<div className="h-full w-full bg-surface-secondary" />}>
            <Suspense fallback={<div className="h-full w-full bg-surface-secondary animate-pulse" />}>
              <GlMapPreview
                provider={provider}
                token={mapboxToken}
                style={mapboxStyle}
                lat={PREVIEW_CENTER[0]}
                lng={PREVIEW_CENTER[1]}
                // Zoom in close so the style's character (3D buildings,
                // satellite texture, label density) is immediately visible.
                zoom={PREVIEW_ZOOM}
                enable3d={provider === 'mapbox-gl' && mapbox3d && supports3d}
                quality={provider === 'mapbox-gl' && mapboxQuality}
              />
            </Suspense>
            </ErrorBoundary>
          ) : (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            React.createElement(MapView as any, {
              places: previewPlaces,
              dayPlaces: [],
              route: null,
              routeSegments: null,
              selectedPlaceId: null,
              onMarkerClick: null,
              onMapClick: null,
              onMapContextMenu: null,
              // With the key on it, or the preview resolves the template as a
              // keyless CARTO one and quietly shows the app default instead of
              // the basemap being configured. The fields hold what the user is
              // editing rather than what useTileUrl already resolved, so the key
              // has to be put back on here.
              tileUrl: withTileApiKey(mapTileUrl, cartoKey),
              fitKey: null,
              dayOrderMap: [],
              leftWidth: 0,
              rightWidth: 0,
              hasInspector: false,
            })
          )}
        </div>
      </div>

      <button type="button"
        onClick={saveMapSettings}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:bg-slate-400"
      >
        {saving ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
        {t('settings.saveMap')}
      </button>
    </Section>
  )
}
