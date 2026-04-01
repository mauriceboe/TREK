import React, { useEffect, useMemo, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { getIntlLanguage, getLocaleForLanguage, useTranslation } from '../i18n'
import { useSettingsStore } from '../store/settingsStore'
import Navbar from '../components/Layout/Navbar'
import apiClient, { mapsApi } from '../api/client'
import CustomSelect from '../components/shared/CustomSelect'
import { Globe, MapPin, Briefcase, Calendar, Flag, ChevronRight, PanelLeftOpen, PanelLeftClose, X, Star, Plus, Trash2, Search } from 'lucide-react'
import L from 'leaflet'
import type { AtlasPlace, GeoJsonFeatureCollection, TranslationFn } from '../types'

// Convert country code to flag emoji
interface AtlasCountry {
  code: string
  tripCount: number
  placeCount: number
  firstVisit?: string | null
  lastVisit?: string | null
}

interface AtlasStats {
  totalTrips: number
  totalPlaces: number
  totalCountries: number
  totalDays: number
  totalCities?: number
}

interface AtlasData {
  countries: AtlasCountry[]
  stats: AtlasStats
  mostVisited?: AtlasCountry | null
  continents?: Record<string, number>
  lastTrip?: { id: number; title: string; countryCode?: string } | null
  nextTrip?: { id: number; title: string; countryCode?: string } | null
  streak?: number
  firstYear?: number
  tripsThisYear?: number
}

interface CountryDetail {
  places: AtlasPlace[]
  trips: { id: number; title: string }[]
  manually_marked?: boolean
}

function MobileStats({ data, stats, countries, resolveName, t, dark }: { data: AtlasData | null; stats: AtlasStats; countries: AtlasCountry[]; resolveName: (code: string) => string; t: TranslationFn; dark: boolean }): React.ReactElement {
  const tp = dark ? '#f1f5f9' : '#0f172a'
  const tf = dark ? '#475569' : '#94a3b8'
  const { continents, lastTrip, nextTrip, streak, firstYear, tripsThisYear } = data || {}
  const CL = { 'Europe': t('atlas.europe'), 'Asia': t('atlas.asia'), 'North America': t('atlas.northAmerica'), 'South America': t('atlas.southAmerica'), 'Africa': t('atlas.africa'), 'Oceania': t('atlas.oceania') }
  const thisYear = new Date().getFullYear()

  return (
    <div className="space-y-4">
      {/* Stats grid */}
      <div className="grid grid-cols-5 gap-2">
        {[[stats.totalCountries, t('atlas.countries')], [stats.totalTrips, t('atlas.trips')], [stats.totalPlaces, t('atlas.places')], [stats.totalCities || 0, t('atlas.cities')], [stats.totalDays, t('atlas.days')]].map(([v, l], i) => (
          <div key={i} className="text-center py-2">
            <p className="text-xl font-black tabular-nums" style={{ color: tp }}>{v}</p>
            <p className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: tf }}>{l}</p>
          </div>
        ))}
      </div>
      {/* Continents */}
      <div className="grid grid-cols-6 gap-1">
        {['Europe', 'Asia', 'North America', 'South America', 'Africa', 'Oceania'].map(cont => {
          const count = continents?.[cont] || 0
          return (
            <div key={cont} className="text-center py-1">
              <p className="text-base font-bold tabular-nums" style={{ color: count > 0 ? tp : (dark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)') }}>{count}</p>
              <p className="text-[8px] font-semibold uppercase" style={{ color: count > 0 ? tf : (dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)') }}>{CL[cont]}</p>
            </div>
          )
        })}
      </div>
      {/* Highlights */}
      <div className="flex gap-3">
        {streak > 0 && (
          <div className="text-center flex-1 py-2">
            <p className="text-xl font-black tabular-nums" style={{ color: tp }}>{streak}</p>
            <p className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: tf }}>{streak === 1 ? t('atlas.yearInRow') : t('atlas.yearsInRow')}</p>
          </div>
        )}
        {tripsThisYear > 0 && (
          <div className="text-center flex-1 py-2">
            <p className="text-xl font-black tabular-nums" style={{ color: tp }}>{tripsThisYear}</p>
            <p className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: tf }}>{tripsThisYear === 1 ? t('atlas.tripIn') : t('atlas.tripsIn')} {thisYear}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function countryCodeToFlag(code: string): string {
  if (!code || code.length !== 2) return ''
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65))
}

function useCountryNames(language: string): (code: string) => string {
  const [resolver, setResolver] = useState<(code: string) => string>(() => (code: string) => code)
  useEffect(() => {
    try {
      const dn = new Intl.DisplayNames([getIntlLanguage(language)], { type: 'region' })
      setResolver(() => (code: string) => { try { return dn.of(code) || code } catch { return code } })
    } catch { /* */ }
  }, [language])
  return resolver
}

// Map visited country codes to ISO-3166 alpha3 (GeoJSON uses alpha3)
// Built dynamically from GeoJSON + hardcoded fallbacks
const A2_TO_A3_BASE: Record<string, string> = {"AF":"AFG","AL":"ALB","DZ":"DZA","AD":"AND","AO":"AGO","AG":"ATG","AR":"ARG","AM":"ARM","AU":"AUS","AT":"AUT","AZ":"AZE","BS":"BHS","BH":"BHR","BD":"BGD","BB":"BRB","BY":"BLR","BE":"BEL","BZ":"BLZ","BJ":"BEN","BT":"BTN","BO":"BOL","BA":"BIH","BW":"BWA","BR":"BRA","BN":"BRN","BG":"BGR","BF":"BFA","BI":"BDI","CV":"CPV","KH":"KHM","CM":"CMR","CA":"CAN","CF":"CAF","TD":"TCD","CL":"CHL","CN":"CHN","CO":"COL","KM":"COM","CG":"COG","CD":"COD","CR":"CRI","CI":"CIV","HR":"HRV","CU":"CUB","CY":"CYP","CZ":"CZE","DK":"DNK","DJ":"DJI","DM":"DMA","DO":"DOM","EC":"ECU","EG":"EGY","SV":"SLV","GQ":"GNQ","ER":"ERI","EE":"EST","SZ":"SWZ","ET":"ETH","FJ":"FJI","FI":"FIN","FR":"FRA","GA":"GAB","GM":"GMB","GE":"GEO","DE":"DEU","GH":"GHA","GR":"GRC","GD":"GRD","GT":"GTM","GN":"GIN","GW":"GNB","GY":"GUY","HT":"HTI","HN":"HND","HU":"HUN","IS":"ISL","IN":"IND","ID":"IDN","IR":"IRN","IQ":"IRQ","IE":"IRL","IL":"ISR","IT":"ITA","JM":"JAM","JP":"JPN","JO":"JOR","KZ":"KAZ","KE":"KEN","KI":"KIR","KP":"PRK","KR":"KOR","KW":"KWT","KG":"KGZ","LA":"LAO","LV":"LVA","LB":"LBN","LS":"LSO","LR":"LBR","LY":"LBY","LI":"LIE","LT":"LTU","LU":"LUX","MG":"MDG","MW":"MWI","MY":"MYS","MV":"MDV","ML":"MLI","MT":"MLT","MR":"MRT","MU":"MUS","MX":"MEX","MD":"MDA","MN":"MNG","ME":"MNE","MA":"MAR","MZ":"MOZ","MM":"MMR","NA":"NAM","NP":"NPL","NL":"NLD","NZ":"NZL","NI":"NIC","NE":"NER","NG":"NGA","MK":"MKD","NO":"NOR","OM":"OMN","PK":"PAK","PA":"PAN","PG":"PNG","PY":"PRY","PE":"PER","PH":"PHL","PL":"POL","PT":"PRT","QA":"QAT","RO":"ROU","RU":"RUS","RW":"RWA","SA":"SAU","SN":"SEN","RS":"SRB","SL":"SLE","SG":"SGP","SK":"SVK","SI":"SVN","SB":"SLB","SO":"SOM","ZA":"ZAF","SS":"SSD","ES":"ESP","LK":"LKA","SD":"SDN","SR":"SUR","SE":"SWE","CH":"CHE","SY":"SYR","TW":"TWN","TJ":"TJK","TZ":"TZA","TH":"THA","TL":"TLS","TG":"TGO","TT":"TTO","TN":"TUN","TR":"TUR","TM":"TKM","UG":"UGA","UA":"UKR","AE":"ARE","GB":"GBR","US":"USA","UY":"URY","UZ":"UZB","VU":"VUT","VE":"VEN","VN":"VNM","YE":"YEM","ZM":"ZMB","ZW":"ZWE"}
let A2_TO_A3: Record<string, string> = { ...A2_TO_A3_BASE }

export default function AtlasPage(): React.ReactElement {
  const { t, language } = useTranslation()
  const { settings } = useSettingsStore()
  const navigate = useNavigate()
  const resolveName = useCountryNames(language)
  const dm = settings.dark_mode
  const dark = dm === true || dm === 'dark' || (dm === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstance = useRef<L.Map | null>(null)
  const geoLayerRef = useRef<L.GeoJSON | null>(null)
  const glareRef = useRef<HTMLDivElement>(null)
  const borderGlareRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const country_layer_by_a2_ref = useRef<Record<string, any>>({})

  const handlePanelMouseMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!panelRef.current || !glareRef.current || !borderGlareRef.current) return
    const rect = panelRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    // Subtle inner glow
    glareRef.current.style.background = `radial-gradient(circle 300px at ${x}px ${y}px, ${dark ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.25)'} 0%, transparent 70%)`
    glareRef.current.style.opacity = '1'
    // Border glow that follows cursor
    borderGlareRef.current.style.opacity = '1'
    borderGlareRef.current.style.maskImage = `radial-gradient(circle 150px at ${x}px ${y}px, black 0%, transparent 100%)`
    borderGlareRef.current.style.webkitMaskImage = `radial-gradient(circle 150px at ${x}px ${y}px, black 0%, transparent 100%)`
  }
  const handlePanelMouseLeave = () => {
    if (glareRef.current) glareRef.current.style.opacity = '0'
    if (borderGlareRef.current) borderGlareRef.current.style.opacity = '0'
  }

  const [data, setData] = useState<AtlasData | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState<boolean>(false)
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null)
  const [countryDetail, setCountryDetail] = useState<CountryDetail | null>(null)
  const [geoData, setGeoData] = useState<GeoJsonFeatureCollection | null>(null)
  const [confirmAction, setConfirmAction] = useState<{ type: 'mark' | 'unmark' | 'choose' | 'bucket'; code: string; name: string } | null>(null)
  const [bucketMonth, setBucketMonth] = useState(0)
  const [bucketYear, setBucketYear] = useState(0)

  // Bucket list
  interface BucketItem { id: number; name: string; lat: number | null; lng: number | null; country_code: string | null; notes: string | null; target_date: string | null }
  const [bucketList, setBucketList] = useState<BucketItem[]>([])
  const [showBucketAdd, setShowBucketAdd] = useState(false)
  const [bucketForm, setBucketForm] = useState({ name: '', notes: '', lat: '', lng: '', target_date: '' })
  const [bucketSearch, setBucketSearch] = useState('')
  const [bucketSearchResults, setBucketSearchResults] = useState<any[]>([])
  const [bucketSearching, setBucketSearching] = useState(false)
  const [bucketPoiMonth, setBucketPoiMonth] = useState(0)
  const [bucketPoiYear, setBucketPoiYear] = useState(0)
  const [bucketTab, setBucketTab] = useState<'stats' | 'bucket'>('stats')
  const bucketMarkersRef = useRef<any>(null)

  const [atlas_country_search, set_atlas_country_search] = useState('')
  const [atlas_country_results, set_atlas_country_results] = useState<{ code: string; label: string }[]>([])
  const [atlas_country_open, set_atlas_country_open] = useState(false)

  const atlas_country_options = useMemo(() => {
    if (!geoData) return []
    const opts: { code: string; label: string }[] = []
    const seen = new Set<string>()
    for (const f of (geoData as any).features || []) {
      const a2 = f?.properties?.ISO_A2
      if (!a2 || a2 === '-99' || typeof a2 !== 'string' || a2.length !== 2) continue
      if (seen.has(a2)) continue
      seen.add(a2)
      const label = String(resolveName(a2) || f?.properties?.NAME || f?.properties?.ADMIN || a2)
      opts.push({ code: a2, label })
    }
    opts.sort((a, b) => a.label.localeCompare(b.label))
    return opts
  }, [geoData, resolveName])

  // Load atlas data + bucket list
  useEffect(() => {
    Promise.all([
      apiClient.get('/addons/atlas/stats'),
      apiClient.get('/addons/atlas/bucket-list'),
    ]).then(([statsRes, bucketRes]) => {
      setData(statsRes.data)
      setBucketList(bucketRes.data.items || [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  // Load GeoJSON world data (direct GeoJSON, no conversion needed)
  useEffect(() => {
    fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson')
      .then(r => r.json())
      .then(geo => {
        // Dynamically build A2→A3 mapping from GeoJSON
        for (const f of geo.features) {
          const a2 = f.properties?.ISO_A2
          const a3 = f.properties?.ADM0_A3 || f.properties?.ISO_A3
          if (a2 && a3 && a2 !== '-99' && a3 !== '-99' && !A2_TO_A3[a2]) {
            A2_TO_A3[a2] = a3
          }
        }
        setGeoData(geo)
      })
      .catch(() => {})
  }, [])

  // Initialize map — runs after loading is done and mapRef is available
  useEffect(() => {
    if (loading || !mapRef.current) return
    if (mapInstance.current) { mapInstance.current.remove(); mapInstance.current = null }

    const map = L.map(mapRef.current, {
      center: [25, 0],
      zoom: 3,
      minZoom: 3,
      maxZoom: 7,
      zoomControl: false,
      attributionControl: false,
      maxBounds: [[-90, -220], [90, 220]],
      maxBoundsViscosity: 1.0,
      fadeAnimation: false,
      preferCanvas: true,
    })

    L.control.zoom({ position: 'bottomright' }).addTo(map)

    const tileUrl = dark
      ? 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png'

    L.tileLayer(tileUrl, {
      maxZoom: 8,
      keepBuffer: 25,
      updateWhenZooming: true,
      updateWhenIdle: false,
      tileSize: 256,
      zoomOffset: 0,
      crossOrigin: true
    }).addTo(map)

    // Preload adjacent zoom level tiles
    L.tileLayer(tileUrl, {
      maxZoom: 8,
      keepBuffer: 10,
      opacity: 0,
      tileSize: 256,
      crossOrigin: true,
    }).addTo(map)

    mapInstance.current = map
    return () => { map.remove(); mapInstance.current = null }
  }, [dark, loading])

  // Render GeoJSON countries
  useEffect(() => {
    if (!mapInstance.current || !geoData || !data) return

    const visitedA3 = new Set(data.countries.map(c => A2_TO_A3[c.code]).filter(Boolean))
    const countryMap = {}
    data.countries.forEach(c => { if (A2_TO_A3[c.code]) countryMap[A2_TO_A3[c.code]] = c })

    // Preserve current map view
    const currentCenter = mapInstance.current.getCenter()
    const currentZoom = mapInstance.current.getZoom()

    if (geoLayerRef.current) {
      mapInstance.current.removeLayer(geoLayerRef.current)
    }

    // Generate deterministic color per country code
    const VISITED_COLORS = ['#6366f1','#ec4899','#14b8a6','#f97316','#8b5cf6','#ef4444','#3b82f6','#22c55e','#06b6d4','#f43f5e','#a855f7','#10b981','#0ea5e9','#e11d48','#0d9488','#7c3aed','#2563eb','#dc2626','#059669','#d946ef']
    // Assign colors in order of visit (by index in countries array) so no two neighbors share a color easily
    const visitedA3List = [...visitedA3]
    const colorMap = {}
    visitedA3List.forEach((a3, i) => { colorMap[a3] = VISITED_COLORS[i % VISITED_COLORS.length] })
    const colorForCode = (a3) => colorMap[a3] || VISITED_COLORS[0]

    const canvasRenderer = L.canvas({ padding: 0.5, tolerance: 5 })

    geoLayerRef.current = L.geoJSON(geoData, {
      renderer: canvasRenderer,
      interactive: true,
      bubblingMouseEvents: false,
      style: (feature) => {
        const a3 = feature.properties?.ADM0_A3 || feature.properties?.ISO_A3 || feature.properties?.['ISO3166-1-Alpha-3'] || feature.id
        const visited = visitedA3.has(a3)
        return {
          fillColor: visited ? colorForCode(a3) : (dark ? '#1e1e2e' : '#e2e8f0'),
          fillOpacity: visited ? 0.7 : 0.3,
          color: dark ? '#333' : '#cbd5e1',
          weight: 0.5,
        }
      },
      onEachFeature: (feature, layer) => {
        const a3 = feature.properties?.ADM0_A3 || feature.properties?.ISO_A3 || feature.properties?.['ISO3166-1-Alpha-3'] || feature.id
        const c = countryMap[a3]
        if (c) {
          country_layer_by_a2_ref.current[c.code] = layer
          const name = resolveName(c.code)
          const formatDate = (d) => { if (!d) return '—'; const dt = new Date(d); return dt.toLocaleDateString(getLocaleForLanguage(language), { month: 'short', year: 'numeric' }) }
          const tooltipHtml = `
            <div style="display:flex;flex-direction:column;gap:8px;min-width:160px">
              <div style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;padding-bottom:6px;border-bottom:1px solid ${dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}">${name}</div>
              <div style="display:flex;gap:14px">
                <div><span style="font-size:16px;font-weight:800">${c.tripCount}</span> <span style="font-size:10px;opacity:0.5;text-transform:uppercase;letter-spacing:0.05em">${c.tripCount === 1 ? t('atlas.tripSingular') : t('atlas.tripPlural')}</span></div>
                <div><span style="font-size:16px;font-weight:800">${c.placeCount}</span> <span style="font-size:10px;opacity:0.5;text-transform:uppercase;letter-spacing:0.05em">${c.placeCount === 1 ? t('atlas.placeVisited') : t('atlas.placesVisited')}</span></div>
              </div>
              <div style="display:flex;gap:2px;border-top:1px solid ${dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'};padding-top:8px">
                <div style="flex:1;display:flex;flex-direction:column;gap:2px">
                  <span style="font-size:9px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.4">${t('atlas.firstVisit')}</span>
                  <span style="font-size:12px;font-weight:700">${formatDate(c.firstVisit)}</span>
                </div>
                <div style="flex:1;display:flex;flex-direction:column;gap:2px">
                  <span style="font-size:9px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.4">${t('atlas.lastVisitLabel')}</span>
                  <span style="font-size:12px;font-weight:700">${formatDate(c.lastVisit)}</span>
                </div>
              </div>
              </div>
            </div>`
          layer.bindTooltip(tooltipHtml, {
            sticky: false, permanent: false, className: 'atlas-tooltip', direction: 'top', offset: [0, -10], opacity: 1
          })
          layer.on('click', () => {
            if (c.placeCount === 0 && c.tripCount === 0) {
              // Manually marked only — show unmark popup
              handleUnmarkCountry(c.code)
            } else {
              loadCountryDetail(c.code)
            }
          })
          layer.on('mouseover', (e) => {
            e.target.setStyle({ fillOpacity: 0.9, weight: 2, color: dark ? '#818cf8' : '#4f46e5' })
          })
          layer.on('mouseout', (e) => {
            geoLayerRef.current.resetStyle(e.target)
          })
        } else {
          // Unvisited country — allow clicking to mark as visited
          // Reverse lookup: find A2 code from A3, or use A3 directly
          const a3ToA2Entry = Object.entries(A2_TO_A3).find(([, v]) => v === a3)
          const isoA2 = feature.properties?.ISO_A2
          const countryCode = a3ToA2Entry ? a3ToA2Entry[0] : (isoA2 && isoA2 !== '-99' ? isoA2 : null)
          if (countryCode && countryCode !== '-99') {
            country_layer_by_a2_ref.current[countryCode] = layer
            const name = feature.properties?.NAME || feature.properties?.ADMIN || resolveName(countryCode)
            layer.bindTooltip(`<div style="font-size:12px;font-weight:600">${name}</div>`, {
              sticky: false, className: 'atlas-tooltip', direction: 'top', offset: [0, -10], opacity: 1
            })
            layer.on('click', () => handleMarkCountry(countryCode, name))
            layer.on('mouseover', (e) => {
              e.target.setStyle({ fillOpacity: 0.5, weight: 1.5, color: dark ? '#555' : '#94a3b8' })
            })
            layer.on('mouseout', (e) => {
              geoLayerRef.current.resetStyle(e.target)
            })
          }
        }
      }
    }).addTo(mapInstance.current)

    // Restore map view after re-render
    mapInstance.current.setView(currentCenter, currentZoom, { animate: false })
  }, [geoData, data, dark])

  const handleMarkCountry = (code: string, name: string): void => {
    setConfirmAction({ type: 'choose', code, name })
  }

  const handleUnmarkCountry = (code: string): void => {
    const country = data?.countries.find(c => c.code === code)
    setConfirmAction({ type: 'unmark', code, name: resolveName(code) })
  }

  const select_country_from_search = (country_code: string): void => {
    const country_label = resolveName(country_code)
    set_atlas_country_search(country_label)
    set_atlas_country_open(false)
    set_atlas_country_results([])

    const layer = country_layer_by_a2_ref.current[country_code]
    try {
      if (layer?.getBounds && mapInstance.current) {
        mapInstance.current.fitBounds(layer.getBounds(), { padding: [24, 24], animate: true, maxZoom: 6 })
      }
    } catch (e ) { 
      console.error('Error fitting bounds', e)
     }
    setConfirmAction({ type: 'choose', code: country_code, name: country_label })
  }

  const executeConfirmAction = async (): Promise<void> => {
    if (!confirmAction) return
    const { type, code } = confirmAction
    setConfirmAction(null)

    // Update local state immediately (no API reload = no map re-render flash)
    if (type === 'mark') {
      apiClient.post(`/addons/atlas/country/${code}/mark`).catch(() => {})
      setData(prev => {
        if (!prev || prev.countries.find(c => c.code === code)) return prev
        return {
          ...prev,
          countries: [...prev.countries, { code, placeCount: 0, tripCount: 0, firstVisit: null, lastVisit: null }],
          stats: { ...prev.stats, totalCountries: prev.stats.totalCountries + 1 },
        }
      })
    } else {
      apiClient.delete(`/addons/atlas/country/${code}/mark`).catch(() => {})
      setSelectedCountry(null)
      setCountryDetail(null)
      setData(prev => {
        if (!prev) return prev
        const c = prev.countries.find(c => c.code === code)
        if (!c || c.placeCount > 0 || c.tripCount > 0) return prev
        return {
          ...prev,
          countries: prev.countries.filter(c => c.code !== code),
          stats: { ...prev.stats, totalCountries: Math.max(0, prev.stats.totalCountries - 1) },
        }
      })
    }
  }

  const handleAddBucketItem = async (): Promise<void> => {
    if (!bucketForm.name.trim()) return
    try {
      const data: Record<string, unknown> = { name: bucketForm.name.trim() }
      if (bucketForm.notes.trim()) data.notes = bucketForm.notes.trim()
      if (bucketForm.lat && bucketForm.lng) { data.lat = parseFloat(bucketForm.lat); data.lng = parseFloat(bucketForm.lng) }
      const targetDate = bucketForm.target_date || (bucketPoiMonth > 0 && bucketPoiYear > 0 ? `${bucketPoiYear}-${String(bucketPoiMonth).padStart(2, '0')}` : null)
      if (targetDate) data.target_date = targetDate
      const r = await apiClient.post('/addons/atlas/bucket-list', data)
      setBucketList(prev => [r.data.item, ...prev])
      setBucketForm({ name: '', notes: '', lat: '', lng: '', target_date: '' })
      setBucketSearch(''); setBucketSearchResults([]); setBucketPoiMonth(0); setBucketPoiYear(0)
      setShowBucketAdd(false)
    } catch { /* */ }
  }

  const handleDeleteBucketItem = async (id: number): Promise<void> => {
    try {
      await apiClient.delete(`/addons/atlas/bucket-list/${id}`)
      setBucketList(prev => prev.filter(i => i.id !== id))
    } catch { /* */ }
  }

  const handleBucketPoiSearch = async () => {
    if (!bucketSearch.trim()) return
    setBucketSearching(true)
    try {
      const result = await mapsApi.search(bucketSearch, language)
      setBucketSearchResults(result.places || [])
    } catch {} finally { setBucketSearching(false) }
  }

  const handleSelectBucketPoi = (result: any) => {
    const targetDate = bucketPoiMonth > 0 && bucketPoiYear > 0 ? `${bucketPoiYear}-${String(bucketPoiMonth).padStart(2, '0')}` : null
    setBucketForm({
      name: result.name || bucketSearch,
      notes: '',
      lat: String(result.lat || ''),
      lng: String(result.lng || ''),
      target_date: targetDate || '',
    })
    setBucketSearchResults([])
    setBucketSearch('')
  }

  // Render bucket list markers on map
  useEffect(() => {
    if (!mapInstance.current) return
    if (bucketMarkersRef.current) {
      mapInstance.current.removeLayer(bucketMarkersRef.current)
    }
    if (bucketList.length === 0) return
    const markers = bucketList.filter(b => b.lat && b.lng).map(b => {
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:28px;height:28px;border-radius:50%;background:rgba(251,191,36,0.9);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2px solid white"><svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      })
      return L.marker([b.lat!, b.lng!], { icon }).bindTooltip(
        `<div style="font-size:12px;font-weight:600">${b.name}</div>${b.notes ? `<div style="font-size:10px;opacity:0.7;margin-top:2px">${b.notes}</div>` : ''}`,
        { className: 'atlas-tooltip', direction: 'top', offset: [0, -14] }
      )
    })
    bucketMarkersRef.current = L.layerGroup(markers).addTo(mapInstance.current)
  }, [bucketList])

  const loadCountryDetail = async (code: string): Promise<void> => {
    setSelectedCountry(code)
    try {
      const r = await apiClient.get(`/addons/atlas/country/${code}`)
      setCountryDetail(r.data)
    } catch { /* */ }
  }

  const stats = data?.stats || { totalTrips: 0, totalPlaces: 0, totalCountries: 0, totalDays: 0 }
  const countries = data?.countries || []

  if (loading) {
    return (
      <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
        <Navbar />
        <div className="flex items-center justify-center" style={{ paddingTop: 'var(--nav-h)', minHeight: 'calc(100vh - var(--nav-h))' }}>
          <div className="w-8 h-8 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--text-primary)' }} />
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <Navbar />
      <div style={{ position: 'fixed', top: 'var(--nav-h)', left: 0, right: 0, bottom: 0 }}>
        {/* Map */}
        <div ref={mapRef} style={{ position: 'absolute', inset: 0, zIndex: 1, background: dark ? '#1a1a2e' : '#f0f0f0' }} />
        <div
          className="absolute z-20 flex justify-center"
          style={{ top: 14, left: 0, right: 0, pointerEvents: 'none' }}
        >
          <div style={{ width: 'min(520px, calc(100vw - 28px))', pointerEvents: 'auto' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 16,
              border: '1px solid ' + (dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)'),
              background: dark ? 'rgba(10,10,15,0.55)' : 'rgba(255,255,255,0.55)',
              backdropFilter: 'blur(18px) saturate(180%)',
              WebkitBackdropFilter: 'blur(18px) saturate(180%)',
              boxShadow: dark ? '0 8px 26px rgba(0,0,0,0.25)' : '0 8px 26px rgba(0,0,0,0.10)',
            }}>
              <Search size={16} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
              <input
                value={atlas_country_search}
                onChange={(e) => {
                  const raw = e.target.value
                  set_atlas_country_search(raw)
                  const q = raw.trim().toLowerCase()
                  if (!q) {
                    set_atlas_country_results([])
                    set_atlas_country_open(false)
                    return
                  }
                  const results = atlas_country_options
                    .filter(o => o.label.toLowerCase().includes(q) || o.code.toLowerCase() === q)
                    .slice(0, 8)
                  set_atlas_country_results(results)
                  set_atlas_country_open(true)
                }}
                onFocus={() => {
                  if (atlas_country_results.length > 0) set_atlas_country_open(true)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    set_atlas_country_open(false)
                    return
                  }
                  if (e.key === 'Enter') {
                    const first = atlas_country_results[0]
                    if (first) select_country_from_search(first.code)
                  }
                }}
                placeholder={t('atlas.searchCountry')}
                autoComplete="off"
                spellCheck={false}
                style={{
                  flex: 1,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  fontSize: 13,
                  fontFamily: 'inherit',
                  color: 'var(--text-primary)',
                }}
              />
              {atlas_country_search.trim() && (
                <button
                  onClick={() => {
                    set_atlas_country_search('')
                    set_atlas_country_results([])
                    set_atlas_country_open(false)
                  }}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: 2, display: 'flex' }}
                  aria-label="Clear"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {atlas_country_open && atlas_country_results.length > 0 && (
              <div
                style={{
                  marginTop: 8,
                  borderRadius: 14,
                  overflow: 'hidden',
                  border: '1px solid ' + (dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)'),
                  background: dark ? 'rgba(10,10,15,0.75)' : 'rgba(255,255,255,0.75)',
                  backdropFilter: 'blur(18px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(18px) saturate(180%)',
                  boxShadow: dark ? '0 12px 30px rgba(0,0,0,0.35)' : '0 12px 30px rgba(0,0,0,0.12)',
                }}
                onMouseLeave={() => set_atlas_country_open(false)}
              >
                {atlas_country_results.map((r) => (
                  <button
                    key={r.code}
                    onClick={() => select_country_from_search(r.code)}
                    style={{
                      width: '100%',
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      padding: '10px 12px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontFamily: 'inherit',
                      textAlign: 'left',
                      borderBottom: '1px solid ' + (dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'),
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <img src={`https://flagcdn.com/w40/${r.code.toLowerCase()}.png`} alt={r.code} style={{ width: 28, height: 20, borderRadius: 4, objectFit: 'cover' }} />
                      <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.label}
                      </span>
                    </span>
                    <ChevronRight size={16} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Mobile: Bottom bar */}
        <div className="md:hidden absolute bottom-3 left-0 right-0 z-10 flex justify-center" style={{ touchAction: 'manipulation' }}>
          <div className="flex items-center gap-4 px-5 py-4 rounded-2xl"
            style={{ background: dark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.5)', backdropFilter: 'blur(16px)' }}>
            {/* Countries highlighted */}
            <div className="text-center px-3 py-1.5 rounded-xl" style={{ background: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }}>
              <p className="text-3xl font-black tabular-nums leading-none" style={{ color: 'var(--text-primary)' }}>{stats.totalCountries}</p>
              <p className="text-[9px] font-semibold uppercase tracking-wide mt-1" style={{ color: 'var(--text-faint)' }}>{t('atlas.countries')}</p>
            </div>
            {[[stats.totalTrips, t('atlas.trips')], [stats.totalPlaces, t('atlas.places')], [stats.totalCities || 0, t('atlas.cities')], [stats.totalDays, t('atlas.days')]].map(([v, l], i) => (
              <div key={i} className="text-center px-1">
                <p className="text-xl font-black tabular-nums leading-none" style={{ color: 'var(--text-primary)' }}>{v}</p>
                <p className="text-[9px] font-semibold uppercase tracking-wide mt-1" style={{ color: 'var(--text-faint)' }}>{l}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Desktop Panel — bottom center, glass effect */}
        <div
          ref={panelRef}
          onMouseMove={handlePanelMouseMove}
          onMouseLeave={handlePanelMouseLeave}
          className="hidden md:flex flex-col absolute z-10 overflow-hidden transition-all duration-300"
          style={{
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 'fit-content',
            maxWidth: 'calc(100vw - 40px)',
            background: dark ? 'rgba(10,10,15,0.55)' : 'rgba(255,255,255,0.2)',
            backdropFilter: 'blur(24px) saturate(180%)',
            WebkitBackdropFilter: 'blur(24px) saturate(180%)',
            border: '1px solid ' + (dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'),
            borderRadius: 20,
            boxShadow: dark
              ? '0 8px 32px rgba(0,0,0,0.3)'
              : '0 8px 32px rgba(0,0,0,0.08)',
          }}
        >
          {/* Liquid glass glare effect */}
          <div ref={glareRef} className="absolute inset-0 pointer-events-none" style={{ opacity: 0, transition: 'opacity 0.3s ease', borderRadius: 20 }} />
          {/* Border glow that follows cursor */}
          <div ref={borderGlareRef} className="absolute inset-0 pointer-events-none" style={{
            opacity: 0, transition: 'opacity 0.3s ease', borderRadius: 20,
            border: dark ? '1.5px solid rgba(255,255,255,0.5)' : '2px solid rgba(0,0,0,0.15)',
          }} />
          <SidebarContent
            data={data} stats={stats} countries={countries} selectedCountry={selectedCountry}
            countryDetail={countryDetail} resolveName={resolveName}
            onCountryClick={loadCountryDetail} onTripClick={(id) => navigate(`/trips/${id}`)} onUnmarkCountry={handleUnmarkCountry}
            bucketList={bucketList} bucketTab={bucketTab} setBucketTab={setBucketTab}
            showBucketAdd={showBucketAdd} setShowBucketAdd={setShowBucketAdd}
            bucketForm={bucketForm} setBucketForm={setBucketForm}
            onAddBucket={handleAddBucketItem} onDeleteBucket={handleDeleteBucketItem}
            onSearchBucket={handleBucketPoiSearch} onSelectBucketPoi={handleSelectBucketPoi}
            bucketSearchResults={bucketSearchResults} setBucketSearchResults={setBucketSearchResults} bucketPoiMonth={bucketPoiMonth} setBucketPoiMonth={setBucketPoiMonth}
            bucketPoiYear={bucketPoiYear} setBucketPoiYear={setBucketPoiYear} bucketSearching={bucketSearching}
            bucketSearch={bucketSearch} setBucketSearch={setBucketSearch}
            t={t} dark={dark}
          />
        </div>

      </div>

      {/* Country action popup */}
      {confirmAction && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={() => setConfirmAction(null)}>
          <div style={{ background: 'var(--bg-card)', borderRadius: 16, padding: 24, maxWidth: 340, width: '100%', boxShadow: '0 16px 48px rgba(0,0,0,0.2)', textAlign: 'center' }}
            onClick={e => e.stopPropagation()}>
            {confirmAction.code.length === 2 ? (
              <img src={`https://flagcdn.com/w80/${confirmAction.code.toLowerCase()}.png`} alt={confirmAction.code} style={{ width: 48, height: 34, borderRadius: 6, objectFit: 'cover', marginBottom: 12, display: 'inline-block' }} />
            ) : (
              <div style={{ fontSize: 36, marginBottom: 12 }}>{countryCodeToFlag(confirmAction.code)}</div>
            )}
            <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{confirmAction.name}</h3>

            {confirmAction.type === 'choose' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button onClick={async () => {
                  try {
                    await apiClient.post(`/addons/atlas/country/${confirmAction.code}/mark`)
                    setData(prev => {
                      if (!prev || prev.countries.find(c => c.code === confirmAction.code)) return prev
                      return { ...prev, countries: [...prev.countries, { code: confirmAction.code, placeCount: 0, tripCount: 0, firstVisit: null, lastVisit: null }], stats: { ...prev.stats, totalCountries: prev.stats.totalCountries + 1 } }
                    })
                  } catch {}
                  setConfirmAction(null)
                }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '12px 16px', borderRadius: 12, border: '1px solid var(--border-primary)', background: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', transition: 'background 0.12s' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                  <MapPin size={18} style={{ color: 'var(--text-primary)', flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{t('atlas.markVisited')}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{t('atlas.markVisitedHint')}</div>
                  </div>
                </button>
                <button onClick={() => setConfirmAction({ ...confirmAction, type: 'bucket' as any })}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '12px 16px', borderRadius: 12, border: '1px solid var(--border-primary)', background: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', transition: 'background 0.12s' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                  <Star size={18} style={{ color: '#fbbf24', flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{t('atlas.addToBucket')}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{t('atlas.addToBucketHint')}</div>
                  </div>
                </button>
              </div>
            )}

            {confirmAction.type === 'unmark' && (
              <>
                <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-muted)' }}>{t('atlas.confirmUnmark')}</p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button onClick={() => setConfirmAction(null)}
                    style={{ padding: '8px 20px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
                    {t('common.cancel')}
                  </button>
                  <button onClick={executeConfirmAction}
                    style={{ padding: '8px 20px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', background: '#ef4444', color: 'white' }}>
                    {t('atlas.unmark')}
                  </button>
                </div>
              </>
            )}

            {confirmAction.type === 'bucket' && (
              <>
                <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-muted)' }}>{t('atlas.bucketWhen')}</p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 16 }}>
                  <div style={{ flex: 1 }}>
                    <CustomSelect
                      value={String(bucketMonth)}
                      onChange={v => setBucketMonth(Number(v))}
                      placeholder={t('atlas.month')}
                      options={[
                        { value: '0', label: '—' },
                        ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: new Date(2000, i).toLocaleString(language, { month: 'long' }) })),
                      ]}
                      size="sm"
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <CustomSelect
                      value={String(bucketYear)}
                      onChange={v => setBucketYear(Number(v))}
                      placeholder={t('atlas.year')}
                      options={[
                        { value: '0', label: '—' },
                        ...Array.from({ length: 20 }, (_, i) => ({ value: String(new Date().getFullYear() + i), label: String(new Date().getFullYear() + i) })),
                      ]}
                      size="sm"
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                  <button onClick={() => setConfirmAction({ ...confirmAction, type: 'choose' })}
                    style={{ padding: '8px 20px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
                    {t('common.back')}
                  </button>
                  <button onClick={async () => {
                    const targetDate = bucketMonth > 0 && bucketYear > 0 ? `${bucketYear}-${String(bucketMonth).padStart(2, '0')}` : null
                    try {
                      const r = await apiClient.post('/addons/atlas/bucket-list', { name: confirmAction.name, country_code: confirmAction.code, target_date: targetDate })
                      setBucketList(prev => [r.data.item, ...prev])
                    } catch {}
                    setBucketMonth(0); setBucketYear(0)
                    setConfirmAction(null)
                  }}
                    style={{ padding: '8px 20px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', background: '#fbbf24', color: '#1a1a1a' }}>
                    {t('atlas.addToBucket')}
                  </button>
                </div>
              </>
            )}

            {confirmAction.type === 'mark' && (
              <>
                <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-muted)' }}>{t('atlas.confirmMark')}</p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button onClick={() => setConfirmAction(null)}
                    style={{ padding: '8px 20px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
                    {t('common.cancel')}
                  </button>
                  <button onClick={executeConfirmAction}
                    style={{ padding: '8px 20px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', background: 'var(--text-primary)', color: 'white' }}>
                    {t('atlas.markVisited')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

interface SidebarContentProps {
  data: AtlasData | null
  stats: AtlasStats
  countries: AtlasCountry[]
  selectedCountry: string | null
  countryDetail: CountryDetail | null
  resolveName: (code: string) => string
  onCountryClick: (code: string) => void
  onTripClick: (id: number) => void
  onUnmarkCountry?: (code: string) => void
  bucketList: any[]
  bucketTab: 'stats' | 'bucket'
  setBucketTab: (tab: 'stats' | 'bucket') => void
  showBucketAdd: boolean
  setShowBucketAdd: (v: boolean) => void
  bucketForm: { name: string; notes: string; lat: string; lng: string; target_date: string }
  setBucketForm: (f: { name: string; notes: string; lat: string; lng: string; target_date: string }) => void
  onAddBucket: () => Promise<void>
  onDeleteBucket: (id: number) => Promise<void>
  onSearchBucket: () => Promise<void>
  onSelectBucketPoi: (result: any) => void
  bucketSearchResults: any[]
  setBucketSearchResults: (v: string[]) => void
  bucketPoiMonth: number
  setBucketPoiMonth: (v: number) => void
  bucketPoiYear: number
  setBucketPoiYear: (v: number) => void
  bucketSearching: boolean
  bucketSearch: string
  setBucketSearch: (v: string) => void
  t: TranslationFn
  dark: boolean
}

function SidebarContent({ data, stats, countries, selectedCountry, countryDetail, resolveName, onTripClick, onUnmarkCountry, bucketList, bucketTab, setBucketTab, showBucketAdd, setShowBucketAdd, bucketForm, setBucketForm, onAddBucket, onDeleteBucket, onSearchBucket, onSelectBucketPoi, bucketSearchResults, setBucketSearchResults, bucketPoiMonth, setBucketPoiMonth, bucketPoiYear, setBucketPoiYear, bucketSearching, bucketSearch, setBucketSearch, t, dark }: SidebarContentProps): React.ReactElement {
  const { language } = useTranslation()
  const bg = (o) => dark ? `rgba(255,255,255,${o})` : `rgba(0,0,0,${o})`
  const tp = dark ? '#f1f5f9' : '#0f172a'
  const tm = dark ? '#94a3b8' : '#64748b'
  const tf = dark ? '#475569' : '#94a3b8'
  const accent = '#818cf8'

  const { mostVisited, continents, lastTrip, nextTrip, streak, firstYear, tripsThisYear } = data || {}
  const contEntries = continents ? Object.entries(continents).sort((a, b) => b[1] - a[1]) : []
  const maxCont = contEntries.length > 0 ? contEntries[0][1] : 1
  const CL = { 'Europe': t('atlas.europe'), 'Asia': t('atlas.asia'), 'North America': t('atlas.northAmerica'), 'South America': t('atlas.southAmerica'), 'Africa': t('atlas.africa'), 'Oceania': t('atlas.oceania') }
  const contColors = ['#818cf8', '#f472b6', '#34d399', '#fbbf24', '#fb923c', '#22d3ee']

  // Tab switcher
  const tabBar = (
    <div style={{ display: 'flex', gap: 4, padding: '12px 16px 0', marginBottom: 4 }}>
      {[{ id: 'stats', label: t('atlas.statsTab'), icon: Globe }, { id: 'bucket', label: t('atlas.bucketTab'), icon: Star }].map(tab => (
        <button key={tab.id} onClick={() => setBucketTab(tab.id as any)}
          style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            padding: '7px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            fontSize: 12, fontWeight: 600, transition: 'all 0.15s',
            background: bucketTab === tab.id ? bg(0.1) : 'transparent',
            color: bucketTab === tab.id ? tp : tf,
          }}>
          <tab.icon size={13} />
          {tab.label}
        </button>
      ))}
    </div>
  )

  if (countries.length === 0 && !lastTrip && bucketTab !== 'bucket') {
    return (
      <>
        {tabBar}
        <div className="p-8 text-center">
          <Globe size={28} className="mx-auto mb-2" style={{ color: tf, opacity: 0.4 }} />
          <p className="text-sm font-medium" style={{ color: tm }}>{t('atlas.noData')}</p>
          <p className="text-xs mt-1" style={{ color: tf }}>{t('atlas.noDataHint')}</p>
        </div>
      </>
    )
  }

  const thisYear = new Date().getFullYear()
  const divider = `2px solid ${bg(0.08)}`

  // Bucket list content
  const bucketContent = (
    <>
    <div className="flex items-stretch" style={{ overflowX: 'auto', padding: '0 8px' }}>
      {bucketList.map(item => (
        <div key={item.id} className="group flex flex-col items-center justify-center shrink-0" style={{ padding: '8px 14px', position: 'relative', minWidth: 80 }}>
          {(() => {
            const code = item.country_code?.length === 2 ? item.country_code : (Object.entries(A2_TO_A3).find(([, v]) => v === item.country_code)?.[0] || '')
            return code ? (
              <img src={`https://flagcdn.com/w40/${code.toLowerCase()}.png`} alt={code} style={{ width: 28, height: 20, borderRadius: 4, objectFit: 'cover', marginBottom: 4 }} />
            ) : <Star size={16} style={{ color: '#fbbf24', marginBottom: 4 }} fill="#fbbf24" />
          })()}
          <span className="text-xs font-semibold text-center leading-tight" style={{ color: tp, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
          {item.target_date && (() => {
            const [y, m] = item.target_date.split('-')
            const label = m ? new Date(Number(y), Number(m) - 1).toLocaleString(language, { month: 'short', year: 'numeric' }) : y
            return <span className="text-[9px] mt-0.5 text-center" style={{ color: tf }}>{label}</span>
          })()}
          {!item.target_date && item.notes && <span className="text-[9px] mt-0.5 text-center" style={{ color: tf, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.notes}</span>}
          <button onClick={() => onDeleteBucket(item.id)}
            className="opacity-0 group-hover:opacity-100"
            style={{ position: 'absolute', top: 4, right: 4, background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: tf, display: 'flex', transition: 'opacity 0.15s' }}>
            <X size={10} />
          </button>
        </div>
      ))}
      {bucketList.length === 0 && !showBucketAdd && (
        <div className="flex items-center justify-center py-4 px-6" style={{ color: tf, fontSize: 12 }}>
          {t('atlas.bucketEmptyHint')}
        </div>
      )}
    </div>
    {showBucketAdd ? (
      <div style={{ padding: '8px 16px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* Search or manual name */}
        <div style={{ position: 'relative' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <input type="text" value={bucketForm.name || bucketSearch}
              onChange={e => { const v = e.target.value; if (bucketForm.name) setBucketForm({ ...bucketForm, name: v }); else setBucketSearch(v) }}
              onKeyDown={e => { if (e.key === 'Enter' && !bucketForm.name) onSearchBucket(); else if (e.key === 'Enter') onAddBucket(); if (e.key === 'Escape') setShowBucketAdd(false) }}
              placeholder={t('atlas.bucketNamePlaceholder')}
              autoFocus
              style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-primary)', fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', color: 'var(--text-primary)', background: 'var(--bg-input)' }}
            />
            {!bucketForm.name && (
              <button onClick={onSearchBucket} disabled={bucketSearching}
                style={{ padding: '6px 10px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                <Search size={12} />
              </button>
            )}
            {bucketForm.name && (
              <button onClick={() => { setBucketForm({ ...bucketForm, name: '', lat: '', lng: '' }); setBucketSearch('') }}
                style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', color: 'var(--text-faint)' }}>
                <X size={12} />
              </button>
            )}
          </div>
          {bucketSearchResults.length > 0 && (
            <div style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 50, marginBottom: 4, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.12)', maxHeight: 160, overflowY: 'auto' }}>
              {bucketSearchResults.slice(0, 6).map((r, i) => (
                <button key={i} onClick={() => onSelectBucketPoi(r)} style={{ display: 'flex', flexDirection: 'column', gap: 1, width: '100%', padding: '6px 10px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', borderBottom: '1px solid var(--border-faint)' }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{r.name}</span>
                  {r.address && <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{r.address}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Selected place indicator */}
        {bucketForm.lat && bucketForm.lng && (
          <div style={{ fontSize: 10, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <MapPin size={10} /> {Number(bucketForm.lat).toFixed(4)}, {Number(bucketForm.lng).toFixed(4)}
          </div>
        )}
        {/* Month / Year with CustomSelect */}
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ flex: 1 }}>
            <CustomSelect value={String(bucketPoiMonth)} onChange={v => setBucketPoiMonth(Number(v))} placeholder={t('atlas.month')} size="sm"
              options={[{ value: '0', label: '—' }, ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: new Date(2000, i).toLocaleString(language, { month: 'short' }) }))]} />
          </div>
          <div style={{ flex: 1 }}>
            <CustomSelect value={String(bucketPoiYear)} onChange={v => setBucketPoiYear(Number(v))} placeholder={t('atlas.year')} size="sm"
              options={[{ value: '0', label: '—' }, ...Array.from({ length: 20 }, (_, i) => ({ value: String(new Date().getFullYear() + i), label: String(new Date().getFullYear() + i) }))]} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button onClick={() => { setShowBucketAdd(false); setBucketForm({ name: '', notes: '', lat: '', lng: '', target_date: '' }); setBucketSearch(''); setBucketSearchResults([]); setBucketPoiMonth(0); setBucketPoiYear(0) }}
            style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'none', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
            {t('common.cancel')}
          </button>
          <button onClick={onAddBucket} disabled={!bucketForm.name.trim()}
            style={{ fontSize: 11, padding: '4px 12px', borderRadius: 6, border: 'none', background: '#fbbf24', color: '#1a1a1a', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: bucketForm.name.trim() ? 1 : 0.5 }}>
            {t('common.add')}
          </button>
        </div>
      </div>
    ) : (
      <div style={{ padding: '4px 16px 8px' }}>
        <button onClick={() => setShowBucketAdd(true)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, width: '100%', padding: '5px 0', borderRadius: 8, border: '1px dashed var(--border-primary)', background: 'none', fontSize: 11, color: tf, cursor: 'pointer', fontFamily: 'inherit' }}>
          <Plus size={11} /> {t('atlas.addPoi')}
        </button>
      </div>
    )}
    </>
  )

  return (
    <>
    {tabBar}
    {/* Both tabs always rendered so the wider one sets the panel width */}
    <div style={{ display: 'grid' }}>
    <div style={bucketTab === 'bucket' ? { visibility: 'hidden' as const, gridArea: '1/1' } : { gridArea: '1/1' }}>
    <div className="flex items-stretch justify-center">

      {/* ═══ SECTION 1: Numbers ═══ */}
      {/* Countries hero */}
      <div className="flex items-baseline gap-1.5 px-5 py-4 mx-2 my-2 rounded-xl" style={{ background: bg(0.08) }}>
        <span className="text-5xl font-black tabular-nums leading-none" style={{ color: tp }}>{stats.totalCountries}</span>
        <span className="text-sm font-medium" style={{ color: tm }}>{t('atlas.countries')}</span>
      </div>
      {/* Other stats */}
      {[[stats.totalTrips, t('atlas.trips')], [stats.totalPlaces, t('atlas.places')], [stats.totalCities || 0, t('atlas.cities')], [stats.totalDays, t('atlas.days')]].map(([v, l], i) => (
        <div key={i} className="flex flex-col items-center justify-center px-3 py-5 shrink-0">
          <span className="text-2xl font-black tabular-nums leading-none" style={{ color: tp }}>{v}</span>
          <span className="text-[9px] font-semibold mt-1.5 uppercase tracking-wide whitespace-nowrap" style={{ color: tf }}>{l}</span>
        </div>
      ))}

      {/* ═══ DIVIDER ═══ */}
      <div style={{ width: 2, background: bg(0.08), margin: '12px 14px' }} />

      {/* ═══ SECTION 2: Continents ═══ */}
      <div className="flex items-center gap-4 px-3 py-4 shrink-0">
        {['Europe', 'Asia', 'North America', 'South America', 'Africa', 'Oceania'].map((cont) => {
          const count = continents?.[cont] || 0
          const active = count > 0
          return (
            <div key={cont} className="flex flex-col items-center shrink-0">
              <span className="text-2xl font-black tabular-nums leading-none" style={{ color: active ? tp : bg(0.15) }}>{count}</span>
              <span className="text-[9px] font-semibold mt-1.5 uppercase tracking-wide whitespace-nowrap" style={{ color: active ? tf : bg(0.1) }}>{CL[cont]}</span>
            </div>
          )
        })}
      </div>

      {/* ═══ DIVIDER ═══ */}
      <div style={{ width: 2, background: bg(0.08), margin: '12px 14px' }} />

      {/* ═══ SECTION 3: Highlights & Streaks ═══ */}
      <div className="flex items-center gap-5 px-3 py-4">
        {/* Last trip */}
        {lastTrip && (
          <button onClick={() => onTripClick(lastTrip.id)} className="flex items-center gap-2.5 text-left transition-opacity hover:opacity-75">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0" style={{ background: bg(0.06) }}>
              {lastTrip.countryCode ? countryCodeToFlag(lastTrip.countryCode) : <MapPin size={16} style={{ color: tm }} />}
            </div>
            <div className="min-w-0">
              <p className="text-[9px] uppercase tracking-wider font-semibold" style={{ color: tf }}>{t('atlas.lastTrip')}</p>
              <p className="text-[13px] font-bold truncate" style={{ color: tp }}>{lastTrip.title}</p>
            </div>
          </button>
        )}
        {/* Streak */}
        {streak > 0 && (
          <div className="flex flex-col items-center justify-center px-3">
            <span className="text-2xl font-black tabular-nums leading-none" style={{ color: tp }}>{streak}</span>
            <span className="text-[9px] font-semibold mt-1.5 uppercase tracking-wide text-center leading-tight whitespace-nowrap" style={{ color: tf }}>
              {streak === 1 ? t('atlas.yearInRow') : t('atlas.yearsInRow')}
            </span>
          </div>
        )}
        {/* This year */}
        {tripsThisYear > 0 && (
          <div className="flex flex-col items-center justify-center px-3">
            <span className="text-2xl font-black tabular-nums leading-none" style={{ color: tp }}>{tripsThisYear}</span>
            <span className="text-[9px] font-semibold mt-1.5 uppercase tracking-wide text-center leading-tight whitespace-nowrap" style={{ color: tf }}>
              {tripsThisYear === 1 ? t('atlas.tripIn') : t('atlas.tripsIn')} {thisYear}
            </span>
          </div>
        )}
      </div>

      {/* ═══ Country detail overlay ═══ */}
      {selectedCountry && countryDetail && (
        <>
          <div style={{ width: 2, background: bg(0.08), margin: '12px 0' }} />
          <div className="flex items-center gap-3 px-6 py-4">
            <span className="text-3xl">{countryCodeToFlag(selectedCountry)}</span>
            <div>
              <p className="text-sm font-bold" style={{ color: tp }}>{resolveName(selectedCountry)}</p>
              <p className="text-[10px] mb-1" style={{ color: tf }}>{countryDetail.places.length} {t('atlas.places')} · {countryDetail.trips.length} Trips</p>
              <div className="flex flex-wrap gap-1">
                {countryDetail.trips.slice(0, 3).map(trip => (
                  <button key={trip.id} onClick={() => onTripClick(trip.id)}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold transition-opacity hover:opacity-75"
                    style={{ background: bg(0.08), color: tp }}>
                    <Briefcase size={9} style={{ color: tm }} />
                    {trip.title}
                  </button>
                ))}
                {countryDetail.manually_marked && onUnmarkCountry && (
                  <button onClick={() => onUnmarkCountry(selectedCountry!)}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold transition-opacity hover:opacity-75"
                    style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
                    <X size={9} />
                    {t('atlas.unmark')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
    </div>
    <div style={bucketTab === 'stats' ? { visibility: 'hidden' as const, gridArea: '1/1' } : { gridArea: '1/1' }}>
      {bucketContent}
    </div>
    </div>
    </>
  )
}
