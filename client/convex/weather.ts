import { ConvexError, v } from 'convex/values';
import { action as rawAction } from './_generated/server';

const WMO_MAP: Record<number, string> = {
  0: 'Clear', 1: 'Clear', 2: 'Clouds', 3: 'Clouds',
  45: 'Fog', 48: 'Fog',
  51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle', 56: 'Drizzle', 57: 'Drizzle',
  61: 'Rain', 63: 'Rain', 65: 'Rain', 66: 'Rain', 67: 'Rain',
  71: 'Snow', 73: 'Snow', 75: 'Snow', 77: 'Snow',
  80: 'Rain', 81: 'Rain', 82: 'Rain', 85: 'Snow', 86: 'Snow',
  95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};

const WMO_DESCRIPTION_EN: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Heavy freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snowfall', 73: 'Snowfall', 75: 'Heavy snowfall', 77: 'Snow grains',
  80: 'Light rain showers', 81: 'Rain showers', 82: 'Heavy rain showers',
  85: 'Light snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail',
};

const WMO_DESCRIPTION_DE: Record<number, string> = {
  0: 'Klar', 1: 'Überwiegend klar', 2: 'Teilweise bewölkt', 3: 'Bewölkt',
  45: 'Nebel', 48: 'Nebel mit Reif', 51: 'Leichter Nieselregen', 53: 'Nieselregen', 55: 'Starker Nieselregen',
  56: 'Gefrierender Nieselregen', 57: 'Starker gefr. Nieselregen',
  61: 'Leichter Regen', 63: 'Regen', 65: 'Starker Regen', 66: 'Gefrierender Regen', 67: 'Starker gefr. Regen',
  71: 'Leichter Schneefall', 73: 'Schneefall', 75: 'Starker Schneefall', 77: 'Schneekörner',
  80: 'Leichte Regenschauer', 81: 'Regenschauer', 82: 'Starke Regenschauer',
  85: 'Leichte Schneeschauer', 86: 'Starke Schneeschauer',
  95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'Starkes Gewitter mit Hagel',
};

export const get = rawAction({
  args: { lat: v.number(), lng: v.number(), date: v.string() },
  handler: async (_ctx, args) => {
    try {
      const targetDate = new Date(args.date);
      const now = new Date();
      const diffDays = (targetDate.getTime() - now.getTime()) / (86400000);

      if (diffDays >= -1 && diffDays <= 16) {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${args.lat}&longitude=${args.lng}&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days=16`;
        const response = await fetch(url);
        const data = await response.json() as any;
        if (!response.ok || data.error) return { error: data.reason || 'Weather API error' };

        const dateStr = targetDate.toISOString().slice(0, 10);
        const idx = (data.daily?.time || []).indexOf(dateStr);
        if (idx !== -1) {
          const code = data.daily.weathercode[idx];
          return {
            temp: Math.round((data.daily.temperature_2m_max[idx] + data.daily.temperature_2m_min[idx]) / 2),
            temp_max: Math.round(data.daily.temperature_2m_max[idx]),
            temp_min: Math.round(data.daily.temperature_2m_min[idx]),
            main: WMO_MAP[code] || 'Unknown',
            description: WMO_DESCRIPTION_EN[code] || 'Unknown',
            type: 'forecast',
          };
        }
      }

      // Historical / climate data
      const month = targetDate.getMonth() + 1;
      const day = targetDate.getDate();
      const startDate = `${targetDate.getFullYear() - 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const endDate = startDate;
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${args.lat}&longitude=${args.lng}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`;
      const response = await fetch(url);
      const data = await response.json() as any;
      if (data.daily?.temperature_2m_max?.[0] != null) {
        const tempMax = data.daily.temperature_2m_max[0];
        const tempMin = data.daily.temperature_2m_min[0];
        const precip = data.daily.precipitation_sum?.[0] || 0;
        const tempAvg = (tempMax + tempMin) / 2;
        const main = precip > 5 ? (tempAvg <= 0 ? 'Snow' : 'Rain') : precip > 1 ? 'Drizzle' : precip > 0.3 ? 'Clouds' : tempAvg > 15 ? 'Clear' : 'Clouds';
        return {
          temp: Math.round(tempAvg), temp_max: Math.round(tempMax), temp_min: Math.round(tempMin),
          main, description: `Historical avg for ${args.date}`, type: 'climate',
        };
      }
      return { error: 'No weather data available' };
    } catch {
      return { error: 'Weather service unavailable' };
    }
  },
});

export const getDetailed = rawAction({
  args: { lat: v.number(), lng: v.number(), date: v.string(), lang: v.optional(v.string()) },
  handler: async (_ctx, args) => {
    const lang = args.lang || 'en';
    const descriptions = lang === 'de' ? WMO_DESCRIPTION_DE : WMO_DESCRIPTION_EN;
    try {
      const targetDate = new Date(args.date);
      const now = new Date();
      const diffDays = (targetDate.getTime() - now.getTime()) / 86400000;

      if (diffDays >= -1 && diffDays <= 16) {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${args.lat}&longitude=${args.lng}&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_sum,precipitation_probability_max,windspeed_10m_max,sunrise,sunset&hourly=temperature_2m,precipitation_probability,precipitation,weathercode,windspeed_10m,relativehumidity_2m&timezone=auto&forecast_days=16`;
        const response = await fetch(url);
        const data = await response.json() as any;
        if (!response.ok || data.error) return { error: data.reason || 'Weather API error' };

        const dateStr = targetDate.toISOString().slice(0, 10);
        const idx = (data.daily?.time || []).indexOf(dateStr);
        if (idx === -1) return { error: 'Date not found in forecast' };

        const code = data.daily.weathercode[idx];

        // Extract hourly data for this day
        const hourly: any[] = [];
        if (data.hourly?.time) {
          for (let i = 0; i < data.hourly.time.length; i++) {
            if (data.hourly.time[i].startsWith(dateStr)) {
              const hour = new Date(data.hourly.time[i]).getHours();
              hourly.push({
                hour,
                temp: Math.round(data.hourly.temperature_2m[i]),
                precipitation: data.hourly.precipitation?.[i] || 0,
                precipitation_probability: data.hourly.precipitation_probability?.[i] || 0,
                main: WMO_MAP[data.hourly.weathercode?.[i]] || 'Unknown',
                wind: Math.round(data.hourly.windspeed_10m?.[i] || 0),
                humidity: data.hourly.relativehumidity_2m?.[i] || 0,
              });
            }
          }
        }

        return {
          temp: Math.round((data.daily.temperature_2m_max[idx] + data.daily.temperature_2m_min[idx]) / 2),
          temp_max: Math.round(data.daily.temperature_2m_max[idx]),
          temp_min: Math.round(data.daily.temperature_2m_min[idx]),
          main: WMO_MAP[code] || 'Unknown',
          description: descriptions[code] || 'Unknown',
          type: 'forecast',
          precipitation_sum: data.daily.precipitation_sum?.[idx] ?? 0,
          precipitation_probability_max: data.daily.precipitation_probability_max?.[idx] ?? 0,
          wind_max: data.daily.windspeed_10m_max?.[idx] ? Math.round(data.daily.windspeed_10m_max[idx]) : 0,
          sunrise: data.daily.sunrise?.[idx] || null,
          sunset: data.daily.sunset?.[idx] || null,
          hourly,
        };
      }

      return { error: 'Date out of forecast range', type: 'unavailable' };
    } catch {
      return { error: 'Weather service unavailable' };
    }
  },
});
