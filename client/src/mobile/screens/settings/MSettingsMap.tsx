import React, { useEffect, useMemo, useState, Suspense } from 'react'
import { Box, Check, ChevronDown, Globe2, Layers, Map, Save } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { useSettingsStore } from '../../../store/settingsStore'
import { useAuthStore } from '../../../store/authStore'
import { useToast } from '../../../components/shared/Toast'
import { MapView } from '../../../components/Map/MapView'
// Same as the desktop map settings tab: on demand, and paired with one engine.
import ErrorBoundary from '../../../components/shared/ErrorBoundary'
import { GlMapPreviewMapbox, GlMapPreviewMaplibre } from '../../../components/Map/glLazy'
import type { Place } from '../../../types'
import {
  MAPBOX_DEFAULT_STYLE,
  defaultStyleForProvider,
  getStylePresets,
  isOpenFreeMapStyle,
  normalizeStyleForProvider,
  type GlMapProvider,
} from '../../../components/Map/glProviders'
import { withTileApiKey } from '../../../utils/tileUrl'
import { AMAP_ROAD, AMAP_SATELLITE } from '../../../constants/mapDefaults'
import MToggle from '../../components/MToggle'
import { MSetCard, MSetEyebrow, MSetSelectRow, MSetInput, MSetButton, MSetHint, MSetRow } from './MSettingsUi'
import MSetPickerSheet from './MSetPickerSheet'

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

type Provider = 'leaflet' | GlMapProvider

function normalizeProvider(value: unknown): Provider {
  return value === 'mapbox-gl' || value === 'maplibre-gl' ? value : 'leaflet'
}

function styleForProvider(provider: Provider, style?: string | null): string {
  if (provider === 'leaflet') return style || MAPBOX_DEFAULT_STYLE
  if (provider === 'mapbox-gl' && isOpenFreeMapStyle(style)) return MAPBOX_DEFAULT_STYLE
  return normalizeStyleForProvider(provider, style)
}

// Each GL provider has its own style slot so toggling providers never clobbers
// the other one's style (same rule as the desktop tab).
function slotStyle(provider: Provider, s: { mapbox_style?: string; maplibre_style?: string }): string | undefined {
  return provider === 'maplibre-gl' ? s.maplibre_style : s.mapbox_style
}

// A recognisable city so the preview shows label density / 3D / satellite texture.
const PREVIEW_CENTER: [number, number] = [48.8566, 2.3522]
const PREVIEW_ZOOM = 16

/**
 * "Map" section — MapSettingsTab parity: provider, raster tiles, Mapbox token,
 * GL style, 3D + quality toggles and a live style preview.
 */
export default function MSettingsMap() {
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
  const [presetOpen, setPresetOpen] = useState(false)
  const [styleOpen, setStyleOpen] = useState(false)

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

  const previewPlaces = useMemo(
    (): Place[] => [
      {
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
      },
    ],
    [],
  )

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const glStyle = provider === 'leaflet' ? mapboxStyle : normalizeStyleForProvider(provider, mapboxStyle)
      setMapboxStyle(glStyle)
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
      toast.success(t('settings.toast.mapSaved'))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  const changeProvider = (nextProvider: Provider) => {
    setProvider(nextProvider)
    if (nextProvider !== 'leaflet') setMapboxStyle(styleForProvider(nextProvider, mapboxStyle))
  }
  // Only CARTO burns a watermark into keyless tiles, so the nudge is scoped to its hosts.
  const cartoNeedsKey = mapTileUrl.includes('basemaps.cartocdn.com') && !cartoKey.trim()

  const providers: { id: Provider; name: string; sub: string; icon: typeof Layers }[] = [
    { id: 'leaflet', name: 'Leaflet', sub: t('settings.mapLeafletSubtitle'), icon: Layers },
    { id: 'mapbox-gl', name: 'Mapbox GL', sub: t('settings.mapMapboxSubtitle'), icon: Box },
    { id: 'maplibre-gl', name: 'MapLibre GL', sub: t('settings.mapMapLibreSubtitle'), icon: Globe2 },
  ]

  const presets = provider === 'leaflet' ? [] : getStylePresets(provider)
  const selectedPreset = presets.find((p) => p.url === mapboxStyle)
  const chevron = <ChevronDown size={13} strokeWidth={2} className="flex-none text-m-faint" />

  // One chunk per engine — see components/Map/glLazy.tsx.
  const GlMapPreview = provider === 'maplibre-gl' ? GlMapPreviewMaplibre : GlMapPreviewMapbox

  return (
    <MSetCard title={t('settings.map')} icon={Map}>
      <MSetEyebrow className="mb-[6px]">{t('settings.mapProvider')}</MSetEyebrow>
      <div className="flex flex-col gap-[6px]">
        {providers.map((p) => {
          const active = provider === p.id
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => changeProvider(p.id)}
              className={`flex items-center gap-[10px] rounded-xl border px-[13px] py-[10px] text-left ${
                active
                  ? 'border-transparent bg-m-act text-m-actfg'
                  : 'border-[color:var(--m-rowbr)] bg-[color:var(--m-sheet)] text-m-ink'
              }`}
            >
              <p.icon size={17} strokeWidth={2} className="flex-none" />
              <span className="min-w-0 flex-1">
                <span className="block text-[0.8125rem] font-bold">{p.name}</span>
                <span className={`block font-geist text-[0.625rem] ${active ? 'opacity-70' : 'text-m-muted'}`}>{p.sub}</span>
              </span>
              {active && <Check size={15} strokeWidth={2.5} className="flex-none" />}
            </button>
          )
        })}
      </div>
      <MSetHint>{t('settings.mapProviderHint')}</MSetHint>

      {provider === 'leaflet' && (
        <>
          <MSetEyebrow className="mb-[5px] mt-[14px]">{t('settings.mapTemplate')}</MSetEyebrow>
          <MSetSelectRow
            label={MAP_PRESETS.find((p) => p.url === mapTileUrl)?.name || t('settings.mapTemplatePlaceholder.select')}
            trailing={chevron}
            onClick={() => setPresetOpen(true)}
          />
          <MSetInput
            mono
            className="mt-[6px]"
            value={mapTileUrl}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMapTileUrl(e.target.value)}
            placeholder="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MSetHint>{t('settings.mapDefaultHint')}</MSetHint>

          {/* A managed install brings its own key, same as the Mapbox token below. */}
          {!managed && (
            <>
              <MSetEyebrow className="mb-[5px] mt-[14px]">{t('settings.mapCartoKey')}</MSetEyebrow>
              <MSetInput
                mono
                value={cartoKey}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCartoKey(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <MSetHint>
                {t('settings.mapCartoKeyHint')}{' '}
                <a href="https://carto.com/basemaps/apikey/" target="_blank" rel="noreferrer" className="underline">
                  {t('settings.mapCartoKeyLink')}
                </a>
              </MSetHint>
              {cartoNeedsKey && (
                <p className="mt-[6px] font-geist text-[0.625rem] leading-relaxed text-[color:var(--m-st-pending)]">
                  {t('settings.mapCartoKeyMissing')}
                </p>
              )}
            </>
          )}
        </>
      )}

      {provider !== 'leaflet' && (
        <>
          {provider === 'mapbox-gl' && !managed && (
            <>
              <MSetEyebrow className="mb-[5px] mt-[14px]">{t('settings.mapMapboxToken')}</MSetEyebrow>
              <MSetInput mono value={mapboxToken} onChange={(e) => setMapboxToken(e.target.value)} placeholder="pk.eyJ1Ijoi..." />
              <MSetHint>
                {t('settings.mapMapboxTokenHint')}{' '}
                <a href="https://account.mapbox.com/access-tokens/" target="_blank" rel="noreferrer" className="underline">
                  {t('settings.mapMapboxTokenLink')}
                </a>
              </MSetHint>
            </>
          )}

          <MSetEyebrow className="mb-[5px] mt-[14px]">{t('settings.mapStyle')}</MSetEyebrow>
          <MSetSelectRow
            label={
              selectedPreset
                ? selectedPreset.name
                : provider === 'maplibre-gl'
                  ? t('settings.mapOpenFreeMapStylePlaceholder')
                  : t('settings.mapStylePlaceholder')
            }
            trailing={chevron}
            onClick={() => setStyleOpen(true)}
          />
          <MSetInput
            mono
            className="mt-[6px]"
            value={mapboxStyle}
            onChange={(e) => setMapboxStyle(e.target.value)}
            placeholder={defaultStyleForProvider(provider)}
          />
          <MSetHint>{provider === 'maplibre-gl' ? t('settings.mapOpenFreeMapStyleHint') : t('settings.mapStyleHint')}</MSetHint>

          {provider === 'mapbox-gl' && (
            <div className="mt-1">
              <MSetRow
                label={t('settings.map3dBuildings')}
                sub={t('settings.map3dHint')}
                trailing={<MToggle checked={mapbox3d} onChange={setMapbox3d} ariaLabel={t('settings.map3dBuildings')} />}
              />
              <MSetRow
                label={t('settings.mapHighQuality')}
                sub={`${t('settings.mapHighQualityHint')} ${t('settings.mapHighQualityWarning')}`}
                trailing={<MToggle checked={mapboxQuality} onChange={setMapboxQuality} ariaLabel={t('settings.mapHighQuality')} />}
              />
              <p className="rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] p-3 font-geist text-[0.625rem] leading-relaxed text-m-muted">
                <strong className="text-m-ink">{t('settings.mapTipLabel')}</strong> {t('settings.mapTip')}
              </p>
            </div>
          )}
        </>
      )}

      <div className="relative mt-3 h-[200px] w-full overflow-hidden rounded-xl">
        {provider !== 'leaflet' ? (
          /* See MapSettingsTab: the preview gets its own net. */
          <ErrorBoundary boundaryId="settings:map-preview" resetKeys={[provider]} fallback={<div className="h-full w-full bg-m-card" />}>
          <Suspense fallback={<div className="h-full w-full bg-m-card animate-pulse" />}>
            <GlMapPreview
              provider={provider}
              token={mapboxToken}
              style={mapboxStyle}
              lat={PREVIEW_CENTER[0]}
              lng={PREVIEW_CENTER[1]}
              zoom={PREVIEW_ZOOM}
              enable3d={provider === 'mapbox-gl' && mapbox3d}
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
            // As on the desktop tab: the field holds what is being edited, so the
            // key goes back on before the preview resolves the template.
            tileUrl: withTileApiKey(mapTileUrl, cartoKey),
            fitKey: null,
            dayOrderMap: [],
            leftWidth: 0,
            rightWidth: 0,
            hasInspector: false,
          })
        )}
      </div>

      <MSetButton className="mt-3" onClick={save} disabled={saving}>
        <Save size={14} />
        {t('settings.saveMap')}
      </MSetButton>

      <MSetPickerSheet
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        title={t('settings.mapTemplate')}
        value={mapTileUrl}
        onSelect={setMapTileUrl}
        options={MAP_PRESETS.map((p) => ({ value: p.url, label: p.name }))}
      />

      <MSetPickerSheet
        open={styleOpen}
        onClose={() => setStyleOpen(false)}
        title={t('settings.mapStyle')}
        value={mapboxStyle}
        onSelect={setMapboxStyle}
        options={presets.map((p) => ({
          value: p.url,
          label: (
            <span className="flex flex-wrap items-center gap-1">
              {p.name}
              {(p.tags || []).map((tag) => (
                <span key={tag} className="rounded bg-[color:var(--m-ic)] px-[5px] py-[2px] font-geist text-[0.5625rem] font-bold uppercase tracking-wide text-m-muted">
                  {tag}
                </span>
              ))}
            </span>
          ),
        }))}
      />
    </MSetCard>
  )
}
