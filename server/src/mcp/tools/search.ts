import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { api, ok, mcpErr } from '../apiClient';

export function registerSearchTools(server: McpServer, userId: number): void {

  // search
  server.tool('search', 'Search across trips, places, and days', {
    query: z.string().describe('Search query (minimum 2 characters)'),
    limit: z.number().optional().describe('Max results per type (default: 20, max: 100)'),
  }, async ({ query, limit = 20 }) => {
    try {
      const data = await api.get(userId, `/search?q=${encodeURIComponent(query)}&limit=${limit}`);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Search failed'); }
  });
}

