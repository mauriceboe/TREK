import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { api, ok, mcpErr } from '../apiClient';

export function registerBudgetTools(server: McpServer, userId: number): void {

  // list_budget_items
  server.tool('list_budget_items', 'List all budget items for a trip', {
    trip_id: z.number().describe('Trip ID'),
    category: z.string().optional().describe('Filter by budget category'),
  }, async ({ trip_id, category }) => {
    try {
      const data = await api.get(userId, `/trips/${trip_id}/budget`) as { items: Array<{ category: string }> };
      const items = data.items ?? [];
      const filtered = category ? items.filter(i => i.category === category) : items;
      return ok(filtered);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Trip not found or access denied'); }
  });

  // get_budget_summary
  server.tool('get_budget_summary', 'Get a summary of trip budget grouped by category', {
    trip_id: z.number().describe('Trip ID'),
  }, async ({ trip_id }) => {
    try {
      const data = await api.get(userId, `/trips/${trip_id}/budget`) as { items: Array<{ category: string; total_price: number }> };
      const items = data.items ?? [];
      const grand_total = items.reduce((sum, i) => sum + (i.total_price || 0), 0);
      const by_category = Object.entries(
        items.reduce<Record<string, { items: number; subtotal: number }>>((acc, i) => {
          if (!acc[i.category]) acc[i.category] = { items: 0, subtotal: 0 };
          acc[i.category].items++;
          acc[i.category].subtotal += i.total_price || 0;
          return acc;
        }, {})
      ).map(([category, counts]) => ({ category, ...counts }));
      return ok({ grand_total, total_items: items.length, by_category });
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Trip not found or access denied'); }
  });

  // create_budget_item
  server.tool('create_budget_item', 'Add a budget item to a trip', {
    trip_id: z.number().describe('Trip ID'),
    name: z.string().describe('Item name'),
    category: z.string().describe('Category (e.g. Accommodation, Food, Transport, Activities)'),
    total_price: z.number().describe('Total estimated cost'),
    persons: z.number().optional().describe('Number of persons this covers'),
    days: z.number().optional().describe('Number of days this covers'),
    note: z.string().optional().describe('Additional notes'),
  }, async ({ trip_id, ...body }) => {
    try {
      const data = await api.post(userId, `/trips/${trip_id}/budget`, body);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to create budget item'); }
  });

  // update_budget_item
  server.tool('update_budget_item', 'Update a budget item', {
    trip_id: z.number().describe('Trip ID'),
    item_id: z.number().describe('Budget item ID'),
    name: z.string().optional(),
    category: z.string().optional(),
    total_price: z.number().optional(),
    persons: z.number().optional(),
    days: z.number().optional(),
    note: z.string().optional(),
  }, async ({ trip_id, item_id, ...updates }) => {
    try {
      const data = await api.put(userId, `/trips/${trip_id}/budget/${item_id}`, updates);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to update budget item'); }
  });

  // delete_budget_item
  server.tool('delete_budget_item', 'Delete a budget item', {
    trip_id: z.number().describe('Trip ID'),
    item_id: z.number().describe('Budget item ID'),
  }, async ({ trip_id, item_id }) => {
    try {
      const data = await api.delete(userId, `/trips/${trip_id}/budget/${item_id}`);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to delete budget item'); }
  });
}
