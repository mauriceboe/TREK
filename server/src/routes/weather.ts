import express, { Request, Response } from 'express';
import https from 'https';
import fetch from 'node-fetch';
import { authenticate } from '../middleware/auth';

const router = express.Router();

// Force IPv4 to prevent ETIMEDOUT on Docker bridge networks where IPv6 is unroutable.
// node-fetch v2 ignores NODE_OPTIONS --dns-result-order, so we must pass an explicit agent.
const ipv4Agent = new https.Agent({ family: 4 });

interface WeatherResult {
  temp: number;
  temp_max?: number;
  temp_min?: number;
  main: string;
  description: string;
  type: string;
  sunrise?: string | null;
  sunset?: string | null;
  precipitation_sum?: number;
  precipitation_probability_max?: number;
  wind_max?: number;
  hourly?: HourlyEntry[];
  error?: string;
}

interface HourlyEntry {
  hour: number;
  temp: number;
  precipitation: number;
  precipitation_probability: number;
  main: string;
  wind: number;
  humidity: number;
}

interface OpenMeteoForecast {
  error?: boolean;
  reason?: string;
  current?: { temperature_2m: number; weathercode: number };
  daily?: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    weathercode: number[];
    precipitation_sum?: number[];
    precipitation_probability_max?: number[];
    windspeed_10m_max?: number[];
    sunrise?: string[];
    sunset?: string[];
  };
  hourly?: {
    time: string[];
    temperature_2m: number[];
    precipitation_probability?: number[];
    precipitation?: number[];
    weathercode?: number[];
    windspeed_10m?: number[];
    relativehumidity_2m?: number[];
  };
}

const weatherCache = new Map<string, { data: WeatherResult; expiresAt: number }>();
const CACHE_MAX_ENTRIES = 1000;
const CACHE_PRUNE_TARGET = 500;
const CACHE_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of weatherCache) {
    if (now > entry.expiresAt) weatherCache.delete(key);
  }
  if (weatherCache.size > CACHE_MAX_ENTRIES) {
    const entries = [...weatherCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const toDelete = entries.slice(0, entries.length - CACHE_PRUNE_TARGET);
    toDelete.forEach(([key]) => weatherCache.delete(key));
  }
}, CACHE_CLEANUP_INTERVAL);

const TTL_FORECAST_MS = 60 * 60 * 1000;      // 1 hour
const TTL_CURRENT_MS  = 15 * 60 * 1000;      // 15 minutes
const TTL_CLIMATE_MS  = 24 * 60 * 60 * 1000; // 24 hours

function cacheKey(lat: string, lng: string, date?: string): string {
  const rlat = parseFloat(lat).toFixed(2);
  const rlng = parseFloat(lng).toFixed(2);
  return `${rlat}_${rlng}_${date || 'current'}`;
}

function getCached(key: string) {
  const entry = weatherCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    weatherCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: WeatherResult, ttlMs: number) {
  weatherCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

const WMO_MAP: Record<number, string> = {
  0: 'Clear', 1: 'Clear', 2: 'Clouds', 3: 'Clouds',
  45: 'Fog', 48: 'Fog',
  51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle', 56: 'Drizzle', 57: 'Drizzle',
  61: 'Rain', 63: 'Rain', 65: 'Rain', 66: 'Rain', 67: 'Rain',
  71: 'Snow', 73: 'Snow', 75: 'Snow', 77: 'Snow',
  80: 'Rain', 81: 'Rain', 82: 'Rain',
  85: 'Snow', 86: 'Snow',
  95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};

const WMO_DESCRIPTION_DE: Record<number, string> = {
  0: 'Klar', 1: 'Uberwiegend klar', 2: 'Teilweise bewolkt', 3: 'Bewolkt',
  45: 'Nebel', 48: 'Nebel mit Reif',
  51: 'Leichter Nieselregen', 53: 'Nieselregen', 55: 'Starker Nieselregen',
  56: 'Gefrierender Nieselregen', 57: 'Starker gefr. Nieselregen',
  61: 'Leichter Regen', 63: 'Regen', 65: 'Starker Regen',
  66: 'Gefrierender Regen', 67: 'Starker gefr. Regen',
  71: 'Leichter Schneefall', 73: 'Schneefall', 75: 'Starker Schneefall', 77: 'Schneekorner',
  80: 'Leichte Regenschauer', 81: 'Regenschauer', 82: 'Starke Regenschauer',
  85: 'Leichte Schneeschauer', 86: 'Starke Schneeschauer',
  95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'Starkes Gewitter mit Hagel',
};

const WMO_DESCRIPTION_EN: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Heavy freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snowfall', 73: 'Snowfall', 75: 'Heavy snowfall', 77: 'Snow grains',
  80: 'Light rain showers', 81: 'Rain showers', 82: 'Heavy rain showers',
  85: 'Light snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail',
};

function estimateCondition(tempAvg: number, precipMm: number): string {
  if (precipMm > 5) return tempAvg <= 0 ? 'Snow' : 'Rain';
  if (precipMm > 1) return tempAvg <= 0 ? 'Snow' : 'Drizzle';
  if (precipMm > 0.3) return 'Clouds';
  return tempAvg > 15 ? 'Clear' : 'Clouds';
}

router.get('/', authenticate, async (req: Request, res: Response) => {
  const { lat, lng, date, lang = 'de' } = req.query as { lat: string; lng: string; date?: string; lang?: string };

  if (!lat || !lng) {
    return res.status(400).json({ error: 'Latitude and longitude are required' });
  }

  const ck = cacheKey(lat, lng, date);

  try {
    if (date) {
      const cached = getCached(ck);
      if (cached) return res.json(cached);

      const targetDate = new Date(date);
      const now = new Date();
      const diffDays = (targetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

      if (diffDays >= -1 && diffDays <= 16) {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days=16`;
        const response = await fetch(url, { agent: ipv4Agent });
        const data = await response.json() as OpenMeteoForecast;

        if (!response.ok || data.error) {
          return res.status(response.status || 500).json({ error: data.reason || 'Open-Meteo API error' });
        }

        const dateStr = targetDate.toISOString().slice(0, 10);
        const idx = (data.daily?.time || []).indexOf(dateStr);

        if (idx !== -1) {
          const code = data.daily.weathercode[idx];
          const descriptions = lang === 'de' ? WMO_DESCRIPTION_DE : WMO_DESCRIPTION_EN;

          const result = {
            temp: Math.round((data.daily.temperature_2m_max[idx] + data.daily.temperature_2m_min[idx]) / 2),
            temp_max: Math.round(data.daily.temperature_2m_max[idx]),
            temp_min: Math.round(data.daily.temperature_2m_min[idx]),
            main: WMO_MAP[code] || 'Clouds',
            description: descriptions[code] || '',
            type: 'forecast',
          };

          setCache(ck, result, TTL_FORECAST_MS);
          return res.json(result);
        }
      }

      if (diffDays > -1) {
        const month = targetDate.getMonth() + 1;
        const day = targetDate.getDate();
        const refYear = targetDate.getFullYear() - 1;
        const startDate = new Date(refYear, month - 1, day - 2);
        const endDate = new Date(refYear, month - 1, day + 2);
        const startStr = startDate.toISOString().slice(0, 10);
        const endStr = endDate.toISOString().slice(0, 10);

        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${startStr}&end_date=${endStr}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`;
        const response = await fetch(url, { agent: ipv4Agent });
        const data = await response.json() as OpenMeteoForecast;

        if (!response.ok || data.error) {
          return res.status(response.status || 500).json({ error: data.reason || 'Open-Meteo Climate API error' });
        }

        const daily = data.daily;
        if (!daily || !daily.time || daily.time.length === 0) {
          return res.json({ error: 'no_forecast' });
        }

        let sumMax = 0, sumMin = 0, sumPrecip = 0, count = 0;
        for (let i = 0; i < daily.time.length; i++) {
          if (daily.temperature_2m_max[i] != null && daily.temperature_2m_min[i] != null) {
            sumMax += daily.temperature_2m_max[i];
            sumMin += daily.temperature_2m_min[i];
            sumPrecip += daily.precipitation_sum[i] || 0;
            count++;
          }
        }

        if (count === 0) {
          return res.json({ error: 'no_forecast' });
        }

        const avgMax = sumMax / count;
        const avgMin = sumMin / count;
        const avgTemp = (avgMax + avgMin) / 2;
        const avgPrecip = sumPrecip / count;
        const main = estimateCondition(avgTemp, avgPrecip);

        const result = {
          temp: Math.round(avgTemp),
          temp_max: Math.round(avgMax),
          temp_min: Math.round(avgMin),
          main,
          description: '',
          type: 'climate',
        };

        setCache(ck, result, TTL_CLIMATE_MS);
        return res.json(result);
      }

      return res.json({ error: 'no_forecast' });
    }

    const cached = getCached(ck);
    if (cached) return res.json(cached);

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weathercode&timezone=auto`;
    const response = await fetch(url, { agent: ipv4Agent });
    const data = await response.json() as OpenMeteoForecast;

    if (!response.ok || data.error) {
      return res.status(response.status || 500).json({ error: data.reason || 'Open-Meteo API error' });
    }

    const code = data.current.weathercode;
    const descriptions = lang === 'de' ? WMO_DESCRIPTION_DE : WMO_DESCRIPTION_EN;

    const result = {
      temp: Math.round(data.current.temperature_2m),
      main: WMO_MAP[code] || 'Clouds',
      description: descriptions[code] || '',
      type: 'current',
    };

    setCache(ck, result, TTL_CURRENT_MS);
    res.json(result);
  } catch (err: unknown) {
    console.error('Weather error:', err);
    res.status(500).json({ error: 'Error fetching weather data' });
  }
});

router.get('/detailed', authenticate, async (req: Request, res: Response) => {
  const { lat, lng, date, lang = 'de' } = req.query as { lat: string; lng: string; date: string; lang?: string };

  if (!lat || !lng || !date) {
    return res.status(400).json({ error: 'Latitude, longitude, and date are required' });
  }

  const ck = `detailed_${cacheKey(lat, lng, date)}`;

  try {
    const cached = getCached(ck);
    if (cached) return res.json(cached);

    const targetDate = new Date(date);
    const now = new Date();
    const diffDays = (targetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    const dateStr = targetDate.toISOString().slice(0, 10);
    const descriptions = lang === 'de' ? WMO_DESCRIPTION_DE : WMO_DESCRIPTION_EN;

    if (diffDays > 16) {
      const refYear = targetDate.getFullYear() - 1;
      const refDateStr = `${refYear}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`;

      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}`
        + `&start_date=${refDateStr}&end_date=${refDateStr}`
        + `&hourly=temperature_2m,precipitation,weathercode,windspeed_10m,relativehumidity_2m`
        + `&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_sum,windspeed_10m_max,sunrise,sunset`
        + `&timezone=auto`;
      const response = await fetch(url, { agent: ipv4Agent });
      const data = await response.json() as OpenMeteoForecast;

      if (!response.ok || data.error) {
        return res.status(response.status || 500).json({ error: data.reason || 'Open-Meteo Climate API error' });
      }

      const daily = data.daily;
      const hourly = data.hourly;
      if (!daily || !daily.time || daily.time.length === 0) {
        return res.json({ error: 'no_forecast' });
      }

      const idx = 0;
      const code = daily.weathercode?.[idx];
      const avgMax = daily.temperature_2m_max[idx];
      const avgMin = daily.temperature_2m_min[idx];

      const hourlyData: HourlyEntry[] = [];
      if (hourly?.time) {
        for (let i = 0; i < hourly.time.length; i++) {
          const hour = new Date(hourly.time[i]).getHours();
          const hCode = hourly.weathercode?.[i];
          hourlyData.push({
            hour,
            temp: Math.round(hourly.temperature_2m[i]),
            precipitation: hourly.precipitation?.[i] || 0,
            precipitation_probability: 0,
            main: WMO_MAP[hCode] || 'Clouds',
            wind: Math.round(hourly.windspeed_10m?.[i] || 0),
            humidity: hourly.relativehumidity_2m?.[i] || 0,
          });
        }
      }

      let sunrise: string | null = null, sunset: string | null = null;
      if (daily.sunrise?.[idx]) sunrise = daily.sunrise[idx].split('T')[1]?.slice(0, 5);
      if (daily.sunset?.[idx]) sunset = daily.sunset[idx].split('T')[1]?.slice(0, 5);

      const result = {
        type: 'climate',
        temp: Math.round((avgMax + avgMin) / 2),
        temp_max: Math.round(avgMax),
        temp_min: Math.round(avgMin),
        main: WMO_MAP[code] || estimateCondition((avgMax + avgMin) / 2, daily.precipitation_sum?.[idx] || 0),
        description: descriptions[code] || '',
        precipitation_sum: Math.round((daily.precipitation_sum?.[idx] || 0) * 10) / 10,
        wind_max: Math.round(daily.windspeed_10m_max?.[idx] || 0),
        sunrise,
        sunset,
        hourly: hourlyData,
      };

      setCache(ck, result, TTL_CLIMATE_MS);
      return res.json(result);
    }

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
      + `&hourly=temperature_2m,precipitation_probability,precipitation,weathercode,windspeed_10m,relativehumidity_2m`
      + `&daily=temperature_2m_max,temperature_2m_min,weathercode,sunrise,sunset,precipitation_probability_max,precipitation_sum,windspeed_10m_max`
      + `&timezone=auto&start_date=${dateStr}&end_date=${dateStr}`;

    const response = await fetch(url, { agent: ipv4Agent });
    const data = await response.json() as OpenMeteoForecast;

    if (!response.ok || data.error) {
      return res.status(response.status || 500).json({ error: data.reason || 'Open-Meteo API error' });
    }

    const daily = data.daily;
    const hourly = data.hourly;

    if (!daily || !daily.time || daily.time.length === 0) {
      return res.json({ error: 'no_forecast' });
    }

    const dayIdx = 0;
    const code = daily.weathercode[dayIdx];

    const formatTime = (isoStr: string) => {
      if (!isoStr) return '';
      const d = new Date(isoStr);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    const hourlyData: HourlyEntry[] = [];
    if (hourly && hourly.time) {
      for (let i = 0; i < hourly.time.length; i++) {
        const h = new Date(hourly.time[i]).getHours();
        hourlyData.push({
          hour: h,
          temp: Math.round(hourly.temperature_2m[i]),
          precipitation_probability: hourly.precipitation_probability[i] || 0,
          precipitation: hourly.precipitation[i] || 0,
          main: WMO_MAP[hourly.weathercode[i]] || 'Clouds',
          wind: Math.round(hourly.windspeed_10m[i] || 0),
          humidity: Math.round(hourly.relativehumidity_2m[i] || 0),
        });
      }
    }

    const result = {
      type: 'forecast',
      temp: Math.round((daily.temperature_2m_max[dayIdx] + daily.temperature_2m_min[dayIdx]) / 2),
      temp_max: Math.round(daily.temperature_2m_max[dayIdx]),
      temp_min: Math.round(daily.temperature_2m_min[dayIdx]),
      main: WMO_MAP[code] || 'Clouds',
      description: descriptions[code] || '',
      sunrise: formatTime(daily.sunrise[dayIdx]),
      sunset: formatTime(daily.sunset[dayIdx]),
      precipitation_sum: daily.precipitation_sum[dayIdx] || 0,
      precipitation_probability_max: daily.precipitation_probability_max[dayIdx] || 0,
      wind_max: Math.round(daily.windspeed_10m_max[dayIdx] || 0),
      hourly: hourlyData,
    };

    setCache(ck, result, TTL_FORECAST_MS);
    return res.json(result);
  } catch (err: unknown) {
    console.error('Detailed weather error:', err);
    res.status(500).json({ error: 'Error fetching detailed weather data' });
  }
});

export default router;
