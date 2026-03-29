import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { api, ok, mcpErr } from '../apiClient';

export function registerPackingTools(server: McpServer, userId: number): void {

  // list_packing_items
  server.tool('list_packing_items', 'List all packing items for a trip, grouped by category', {
    trip_id: z.number().describe('Trip ID'),
    category: z.string().optional().describe('Filter by category name'),
  }, async ({ trip_id, category }) => {
    try {
      const data = await api.get(userId, `/trips/${trip_id}/packing`) as { items: Array<{ category: string }> };
      const items = data.items ?? [];
      const filtered = category ? items.filter(i => i.category === category) : items;
      return ok(filtered);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Trip not found or access denied'); }
  });

  // create_packing_item
  server.tool('create_packing_item', 'Add a new packing item', {
    trip_id: z.number().describe('Trip ID'),
    name: z.string().describe('Item name'),
    category: z.string().optional().describe('Category name (e.g. Clothing, Toiletries, Electronics)'),
  }, async ({ trip_id, name, category }) => {
    try {
      const data = await api.post(userId, `/trips/${trip_id}/packing`, { name, category });
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to create packing item'); }
  });

  // toggle_packing_item
  server.tool('toggle_packing_item', 'Mark a packing item as packed or unpacked', {
    trip_id: z.number().describe('Trip ID'),
    item_id: z.number().describe('Packing item ID'),
    checked: z.boolean().describe('true = packed, false = not packed'),
  }, async ({ trip_id, item_id, checked }) => {
    try {
      const data = await api.put(userId, `/trips/${trip_id}/packing/${item_id}`, { checked });
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to update packing item'); }
  });

  // delete_packing_item
  server.tool('delete_packing_item', 'Delete a packing item', {
    trip_id: z.number().describe('Trip ID'),
    item_id: z.number().describe('Packing item ID'),
  }, async ({ trip_id, item_id }) => {
    try {
      const data = await api.delete(userId, `/trips/${trip_id}/packing/${item_id}`);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to delete packing item'); }
  });

  // list_packing_categories
  server.tool('list_packing_categories', 'List all packing categories for a trip with item counts', {
    trip_id: z.number().describe('Trip ID'),
  }, async ({ trip_id }) => {
    try {
      const data = await api.get(userId, `/trips/${trip_id}/packing`) as { items: Array<{ category: string; checked: number }> };
      const items = data.items ?? [];
      const byCategory = items.reduce<Record<string, { total: number; packed: number }>>((acc, item) => {
        if (!acc[item.category]) acc[item.category] = { total: 0, packed: 0 };
        acc[item.category].total++;
        if (item.checked) acc[item.category].packed++;
        return acc;
      }, {});
      const categories = Object.entries(byCategory).map(([category, counts]) => ({ category, ...counts }));
      return ok(categories);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Trip not found or access denied'); }
  });

  // set_packing_category_assignee
  server.tool('set_packing_category_assignee', 'Assign a category\'s packing responsibility to a trip member', {
    trip_id: z.number().describe('Trip ID'),
    category: z.string().describe('Category name'),
    user_id: z.number().describe('User ID to assign (must be a trip member)'),
  }, async ({ trip_id, category, user_id: targetUserId }) => {
    try {
      const data = await api.put(userId, `/trips/${trip_id}/packing/category-assignees/${encodeURIComponent(category)}`, { user_ids: [targetUserId] });
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to set category assignee'); }
  });
}
