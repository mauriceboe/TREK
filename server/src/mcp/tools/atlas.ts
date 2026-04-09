import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { isDemoUser } from '../../services/authService';
import {
  markCountryVisited, unmarkCountryVisited, createBucketItem, deleteBucketItem,
  getStats as getAtlasStats, listManuallyVisitedRegions,
  markRegionVisited, unmarkRegionVisited, getCountryPlaces, updateBucketItem,
} from '../../services/atlasService';
import { isAddonEnabled } from '../../services/adminService';
import {
  TOOL_ANNOTATIONS_WRITE, TOOL_ANNOTATIONS_DELETE, TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  TOOL_ANNOTATIONS_READONLY,
  demoDenied, ok,
} from './_shared';

export function registerAtlasTools(server: McpServer, userId: number): void {
  // --- BUCKET LIST ---

  server.registerTool(
    'create_bucket_list_item',
    {
      description: 'Add a destination to your personal travel bucket list.',
      inputSchema: {
        name: z.string().min(1).max(200).describe('Destination or experience name'),
        lat: z.number().optional(),
        lng: z.number().optional(),
        country_code: z.string().length(2).toUpperCase().optional().describe('ISO 3166-1 alpha-2 country code'),
        notes: z.string().max(1000).optional(),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ name, lat, lng, country_code, notes }) => {
      if (isDemoUser(userId)) return demoDenied();
      const item = createBucketItem(userId, { name, lat, lng, country_code, notes });
      return ok({ item });
    }
  );

  server.registerTool(
    'delete_bucket_list_item',
    {
      description: 'Remove an item from your travel bucket list.',
      inputSchema: {
        itemId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ itemId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const deleted = deleteBucketItem(userId, itemId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Bucket list item not found.' }], isError: true };
      return ok({ success: true });
    }
  );

  // --- ATLAS ---

  server.registerTool(
    'mark_country_visited',
    {
      description: 'Mark a country as visited in your Atlas.',
      inputSchema: {
        country_code: z.string().length(2).toUpperCase().describe('ISO 3166-1 alpha-2 country code (e.g. "FR", "JP")'),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ country_code }) => {
      if (isDemoUser(userId)) return demoDenied();
      markCountryVisited(userId, country_code.toUpperCase());
      return ok({ success: true, country_code: country_code.toUpperCase() });
    }
  );

  server.registerTool(
    'unmark_country_visited',
    {
      description: 'Remove a country from your visited countries in Atlas.',
      inputSchema: {
        country_code: z.string().length(2).toUpperCase().describe('ISO 3166-1 alpha-2 country code'),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ country_code }) => {
      if (isDemoUser(userId)) return demoDenied();
      unmarkCountryVisited(userId, country_code.toUpperCase());
      return ok({ success: true, country_code: country_code.toUpperCase() });
    }
  );

  // --- ATLAS EXPANDED ---

  if (isAddonEnabled('atlas')) {
    server.registerTool(
      'get_atlas_stats',
      {
        description: 'Get atlas statistics — total visited countries, region counts, continent breakdown.',
        inputSchema: {},
        annotations: TOOL_ANNOTATIONS_READONLY,
      },
      async () => {
        const stats = await getAtlasStats(userId);
        return ok({ stats });
      }
    );

    server.registerTool(
      'list_visited_regions',
      {
        description: 'List all manually visited sub-country regions for the current user.',
        inputSchema: {},
        annotations: TOOL_ANNOTATIONS_READONLY,
      },
      async () => {
        const regions = listManuallyVisitedRegions(userId);
        return ok({ regions });
      }
    );

    server.registerTool(
      'mark_region_visited',
      {
        description: 'Mark a sub-country region as visited.',
        inputSchema: {
          regionCode: z.string().describe('ISO region code e.g. US-CA'),
          regionName: z.string(),
          countryCode: z.string().describe('ISO 3166-1 alpha-2 country code'),
        },
        annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
      },
      async ({ regionCode, regionName, countryCode }) => {
        if (isDemoUser(userId)) return demoDenied();
        markRegionVisited(userId, regionCode, regionName, countryCode);
        const region = listManuallyVisitedRegions(userId).find(r => r.region_code === regionCode);
        return ok({ region });
      }
    );

    server.registerTool(
      'unmark_region_visited',
      {
        description: 'Remove a region from the visited list.',
        inputSchema: {
          regionCode: z.string(),
        },
        annotations: TOOL_ANNOTATIONS_DELETE,
      },
      async ({ regionCode }) => {
        if (isDemoUser(userId)) return demoDenied();
        unmarkRegionVisited(userId, regionCode);
        return ok({ success: true });
      }
    );

    server.registerTool(
      'get_country_atlas_places',
      {
        description: 'Get places saved in the user\'s atlas for a specific country.',
        inputSchema: {
          countryCode: z.string().describe('ISO 3166-1 alpha-2 country code'),
        },
        annotations: TOOL_ANNOTATIONS_READONLY,
      },
      async ({ countryCode }) => {
        const result = getCountryPlaces(userId, countryCode);
        return ok(result);
      }
    );

    server.registerTool(
      'update_bucket_list_item',
      {
        description: 'Update a bucket list item (notes, name, target date, location).',
        inputSchema: {
          itemId: z.number().int().positive(),
          name: z.string().optional(),
          notes: z.string().optional(),
          lat: z.number().nullable().optional(),
          lng: z.number().nullable().optional(),
          country_code: z.string().optional(),
          target_date: z.string().nullable().optional(),
        },
        annotations: TOOL_ANNOTATIONS_WRITE,
      },
      async ({ itemId, name, notes, lat, lng, country_code, target_date }) => {
        if (isDemoUser(userId)) return demoDenied();
        const item = updateBucketItem(userId, itemId, { name, notes, lat, lng, country_code, target_date });
        if (!item) return { content: [{ type: 'text' as const, text: 'Bucket list item not found.' }], isError: true };
        return ok({ item });
      }
    );
  }
}
