import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { api, ok, mcpErr } from '../apiClient';

export function registerDayTools(server: McpServer, userId: number): void {

  // list_days
  server.tool('list_days', 'List all days for a trip', {
    trip_id: z.number().describe('Trip ID'),
  }, async ({ trip_id }) => {
    try {
      const data = await api.get(userId, `/trips/${trip_id}/days`) as { days: unknown[] };
      return ok(data.days ?? data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Trip not found or access denied'); }
  });

  // get_day
  server.tool('get_day', 'Get a specific day including its scheduled places', {
    trip_id: z.number().describe('Trip ID'),
    day_number: z.number().describe('Day number (1-based)'),
  }, async ({ trip_id, day_number }) => {
    try {
      const data = await api.get(userId, `/trips/${trip_id}/days`) as { days: Array<{ day_number: number }> };
      const day = (data.days ?? []).find(d => d.day_number === day_number);
      if (!day) return mcpErr(`Day ${day_number} not found`);
      return ok(day);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Trip not found or access denied'); }
  });

  // create_day
  server.tool('create_day', 'Add a new day to a trip', {
    trip_id: z.number().describe('Trip ID'),
    title: z.string().optional().describe('Day title'),
    notes: z.string().optional().describe('Day notes'),
    date: z.string().optional().describe('Date for this day (YYYY-MM-DD)'),
  }, async ({ trip_id, title, notes, date }) => {
    try {
      const data = await api.post(userId, `/trips/${trip_id}/days`, { title, notes, date });
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to create day'); }
  });

  // update_day
  server.tool('update_day', 'Update a day\'s title, notes, or date', {
    trip_id: z.number().describe('Trip ID'),
    day_number: z.number().describe('Day number (1-based)'),
    title: z.string().optional().describe('New title'),
    notes: z.string().optional().describe('New notes'),
    date: z.string().optional().describe('New date (YYYY-MM-DD)'),
  }, async ({ trip_id, day_number, title, notes, date }) => {
    try {
      const listData = await api.get(userId, `/trips/${trip_id}/days`) as { days: Array<{ id: number; day_number: number }> };
      const day = (listData.days ?? []).find(d => d.day_number === day_number);
      if (!day) return mcpErr(`Day ${day_number} not found`);
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (notes !== undefined) body.notes = notes;
      if (date !== undefined) body.date = date;
      const data = await api.put(userId, `/trips/${trip_id}/days/${day.id}`, body);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to update day'); }
  });

  // delete_day
  server.tool('delete_day', 'Delete a day from a trip', {
    trip_id: z.number().describe('Trip ID'),
    day_number: z.number().describe('Day number to delete (1-based)'),
  }, async ({ trip_id, day_number }) => {
    try {
      const listData = await api.get(userId, `/trips/${trip_id}/days`) as { days: Array<{ id: number; day_number: number }> };
      const day = (listData.days ?? []).find(d => d.day_number === day_number);
      if (!day) return mcpErr(`Day ${day_number} not found`);
      const data = await api.delete(userId, `/trips/${trip_id}/days/${day.id}`);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to delete day'); }
  });
}
