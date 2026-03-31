import axios from 'axios';
import { db } from '../db/database';

export interface FlightData {
  number: string;
  airline: string;
  departure: {
    airport: string;
    iata: string;
    time: string;
    lat: number;
    lng: number;
  };
  arrival: {
    airport: string;
    iata: string;
    time: string;
    lat: number;
    lng: number;
  };
  status: string;
}

export async function fetchFlightData(flightNumber: string, date: string): Promise<FlightData[]> {
  const admin = db.prepare("SELECT rapidapi_key FROM users WHERE role = 'admin' AND rapidapi_key IS NOT NULL AND rapidapi_key != '' LIMIT 1").get() as { rapidapi_key: string } | undefined;
  const apiKey = admin?.rapidapi_key;

  if (!apiKey) {
    throw new Error('RapidAPI Key not configured in Admin Settings.');
  }

  const options = {
    method: 'GET',
    url: `https://aerodatabox.p.rapidapi.com/flights/number/${flightNumber}/${date}`,
    params: {
      withAircraftImage: 'false',
      withLocation: 'true', // We need location for the map
      withFlightPlan: 'false',
      dateLocalRole: 'Both'
    },
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
      'Content-Type': 'application/json'
    }
  };

  try {
    const response = await axios.request(options);
    const data = response.data;

    if (!Array.isArray(data) || data.length === 0) {
      return [];
    }

    return data.map((f: any) => ({
      number: f.number,
      airline: f.airline?.name || 'Unknown Airline',
      departure: {
        airport: f.departure?.airport?.name || '',
        iata: f.departure?.airport?.iata || '',
        time: (f.departure?.scheduledTime?.local || f.departure?.scheduledTimeLocal || '').replace(' ', 'T'),
        lat: f.departure?.airport?.location?.lat || 0,
        lng: f.departure?.airport?.location?.lon || 0,
      },
      arrival: {
        airport: f.arrival?.airport?.name || '',
        iata: f.arrival?.airport?.iata || '',
        time: (f.arrival?.scheduledTime?.local || f.arrival?.scheduledTimeLocal || '').replace(' ', 'T'),
        lat: f.arrival?.airport?.location?.lat || 0,
        lng: f.arrival?.airport?.location?.lon || 0,
      },
      status: f.status || 'Unknown'
    }));
  } catch (error: any) {
    if (error.response?.status === 404) return [];
    console.error('Error fetching flight data:', error.message);
    throw new Error('Failed to fetch flight data from AeroDataBox.');
  }
}
