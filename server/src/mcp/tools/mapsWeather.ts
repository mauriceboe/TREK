import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { searchPlaces, getPlaceDetails, reverseGeocode, resolveGoogleMapsUrl } from '../../services/mapsService';
import { getWeather, getDetailedWeather } from '../../services/weatherService';
import {
  TOOL_ANNOTATIONS_READONLY,
  ok,
} from './_shared';

export function registerMapsWeatherTools(server: McpServer, userId: number): void {
  // --- MAPS EXTRAS ---

  server.registerTool(
    'get_place_details',
    {
      description: 'Fetch detailed information about a place by its Google Place ID.',
      inputSchema: {
        placeId: z.string().describe('Google Place ID'),
        lang: z.string().optional().default('en'),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ placeId, lang }) => {
      const details = await getPlaceDetails(userId, placeId, lang ?? 'en');
      if (!details) return { content: [{ type: 'text' as const, text: 'Place not found or maps service not configured.' }], isError: true };
      return ok({ details });
    }
  );

  server.registerTool(
    'reverse_geocode',
    {
      description: 'Get a human-readable address for given coordinates.',
      inputSchema: {
        lat: z.number(),
        lng: z.number(),
        lang: z.string().optional().default('en'),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ lat, lng, lang }) => {
      const result = await reverseGeocode(String(lat), String(lng), lang ?? 'en');
      if (!result) return { content: [{ type: 'text' as const, text: 'Reverse geocode failed or maps service not configured.' }], isError: true };
      return ok(result);
    }
  );

  server.registerTool(
    'resolve_maps_url',
    {
      description: 'Resolve a Google Maps share URL to coordinates and place name.',
      inputSchema: {
        url: z.string().describe('Google Maps share URL'),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ url }) => {
      const result = await resolveGoogleMapsUrl(url);
      if (!result) return { content: [{ type: 'text' as const, text: 'Could not resolve URL or maps service not configured.' }], isError: true };
      return ok(result);
    }
  );

  // --- WEATHER ---

  server.registerTool(
    'get_weather',
    {
      description: 'Get weather forecast for a location and date.',
      inputSchema: {
        lat: z.number(),
        lng: z.number(),
        date: z.string().describe('ISO date YYYY-MM-DD'),
        lang: z.string().optional().default('en'),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ lat, lng, date, lang }) => {
      try {
        const weather = await getWeather(String(lat), String(lng), date, lang ?? 'en');
        return ok({ weather });
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: err?.message ?? 'Weather service not available.' }], isError: true };
      }
    }
  );

  server.registerTool(
    'get_detailed_weather',
    {
      description: 'Get hourly/detailed weather forecast for a location and date.',
      inputSchema: {
        lat: z.number(),
        lng: z.number(),
        date: z.string().describe('ISO date YYYY-MM-DD'),
        lang: z.string().optional().default('en'),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ lat, lng, date, lang }) => {
      try {
        const weather = await getDetailedWeather(String(lat), String(lng), date, lang ?? 'en');
        return ok({ weather });
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: err?.message ?? 'Weather service not available.' }], isError: true };
      }
    }
  );
}
