import { useState, useEffect } from 'react'
import { Sun, Cloud, CloudRain, CloudSnow, CloudDrizzle, CloudLightning, Wind } from 'lucide-react'
import { convexWeatherApi as weatherApi } from '../../convex/mapsClient'
import { useSettingsStore } from '../../store/settingsStore'

const WEATHER_ICON_MAP = {
  Clear: Sun,
  Clouds: Cloud,
  Rain: CloudRain,
  Drizzle: CloudDrizzle,
  Thunderstorm: CloudLightning,
  Snow: CloudSnow,
  Mist: Wind,
  Fog: Wind,
  Haze: Wind,
}

interface WeatherIconProps {
  main: string
  size?: number
}

function WeatherIcon({ main, size = 13 }: WeatherIconProps) {
  const Icon = WEATHER_ICON_MAP[main] || Cloud
  return <Icon size={size} strokeWidth={1.8} />
}

function getWeatherCache(key) {
  try {
    const raw = sessionStorage.getItem(key)
    if (raw === null) return undefined
    return JSON.parse(raw)
  } catch { return undefined }
}

function setWeatherCache(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)) } catch {}
}

interface WeatherWidgetProps {
  lat: number | null
  lng: number | null
  date: string
  compact?: boolean
}

export default function WeatherWidget({ lat, lng, date, compact = false }: WeatherWidgetProps) {
  const [weather, setWeather] = useState(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const isFahrenheit = useSettingsStore(s => s.settings.temperature_unit) === 'fahrenheit'

  useEffect(() => {
    if (!lat || !lng || !date) return
    const rLat = Math.round(lat * 100) / 100
    const rLng = Math.round(lng * 100) / 100
    const cacheKey = `weather_${rLat}_${rLng}_${date}`
    const cached = getWeatherCache(cacheKey)
    if (cached !== undefined) {
      if (cached === null) setFailed(true)
      // Climate data: use from cache but re-fetch in background to upgrade to forecast
      else if (cached.type === 'climate') {
        setWeather(cached)
        weatherApi.get(lat, lng, date)
          .then(data => {
            if (!data.error && data.temp !== undefined && data.type === 'forecast') {
              setWeatherCache(cacheKey, data)
              setWeather(data)
            }
          })
          .catch(() => {})
        return
      } else {
        setWeather(cached)
        return
      }
      return
    }
    setLoading(true)
    weatherApi.get(lat, lng, date)
      .then(data => {
        if (data.error || data.temp === undefined) {
          setFailed(true)
        } else {
          setWeatherCache(cacheKey, data)
          setWeather(data)
        }
      })
      .catch(() => { setFailed(true) })
      .finally(() => setLoading(false))
  }, [lat, lng, date])

  if (!lat || !lng) return null

  const fontStyle = { fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }

  if (loading) {
    return (
      <span style={{ fontSize: 11, color: '#d1d5db', ...fontStyle }}>…</span>
    )
  }

  if (failed || !weather) {
    return (
      <span style={{ fontSize: 11, color: '#9ca3af', ...fontStyle }}>—</span>
    )
  }

  const rawTemp = weather.temp
  const temp = rawTemp !== undefined ? Math.round(isFahrenheit ? rawTemp * 9/5 + 32 : rawTemp) : null
  const unit = isFahrenheit ? '°F' : '°C'
  const isClimate = weather.type === 'climate'

  if (compact) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: isClimate ? '#a1a1aa' : '#6b7280', ...fontStyle }}>
        <WeatherIcon main={weather.main} size={12} />
        {temp !== null && <span>{isClimate ? 'Ø ' : ''}{temp}{unit}</span>}
      </span>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: isClimate ? '#71717a' : '#374151', background: 'rgba(0,0,0,0.04)', borderRadius: 8, padding: '5px 10px', ...fontStyle }}>
      <WeatherIcon main={weather.main} size={15} />
      {temp !== null && <span style={{ fontWeight: 500 }}>{isClimate ? 'Ø ' : ''}{temp}{unit}</span>}
      {weather.description && <span style={{ fontSize: 11, color: '#9ca3af', textTransform: 'capitalize' }}>{weather.description}</span>}
    </div>
  )
}
