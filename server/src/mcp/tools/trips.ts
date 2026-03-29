import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { api, ok, mcpErr } from '../apiClient';

export function registerTripTools(server: McpServer, userId: number): void {

  // list_trips
  server.tool('list_trips', 'List all trips for the current user', {
    archived: z.boolean().optional().describe('Include archived trips (default: false)'),
  }, async ({ archived }) => {
    try {
      const data = await api.get(userId, `/trips${archived ? '?archived=1' : ''}`) as { trips: unknown[] };
      return ok(data.trips ?? data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to list trips'); }
  });

  // get_trip
  server.tool('get_trip', 'Get details of a specific trip', {
    trip_id: z.number().describe('Trip ID'),
  }, async ({ trip_id }) => {
    try {
      const data = await api.get(userId, `/trips/${trip_id}`);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Trip not found or access denied'); }
  });

  // get_trip_context
  server.tool('get_trip_context', 'Get the full trip context: trip details, days, places, assignments, packing, budget, and members in one call', {
    trip_id: z.number().describe('Trip ID'),
  }, async ({ trip_id }) => {
    try {
      const data = await api.get(userId, `/trips/${trip_id}/context`);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Trip not found or access denied'); }
  });

  // create_trip
  server.tool('create_trip', 'Create a new trip', {
    title: z.string().describe('Trip title'),
    description: z.string().optional().describe('Trip description'),
    start_date: z.string().optional().describe('Start date (YYYY-MM-DD)'),
    end_date: z.string().optional().describe('End date (YYYY-MM-DD)'),
    currency: z.string().optional().describe('Currency code (default: EUR)'),
  }, async ({ title, description, start_date, end_date, currency }) => {
    try {
      const data = await api.post(userId, '/trips', { title, description, start_date, end_date, currency });
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to create trip'); }
  });

  // update_trip
  server.tool('update_trip', 'Update trip details', {
    trip_id: z.number().describe('Trip ID'),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description'),
    start_date: z.string().optional().describe('New start date (YYYY-MM-DD)'),
    end_date: z.string().optional().describe('New end date (YYYY-MM-DD)'),
    currency: z.string().optional().describe('New currency code'),
  }, async ({ trip_id, title, description, start_date, end_date, currency }) => {
    try {
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (description !== undefined) body.description = description;
      if (start_date !== undefined) body.start_date = start_date;
      if (end_date !== undefined) body.end_date = end_date;
      if (currency !== undefined) body.currency = currency;
      const data = await api.put(userId, `/trips/${trip_id}`, body);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to update trip'); }
  });

  // archive_trip
  server.tool('archive_trip', 'Archive or unarchive a trip', {
    trip_id: z.number().describe('Trip ID'),
    archived: z.boolean().describe('true to archive, false to unarchive'),
  }, async ({ trip_id, archived }) => {
    try {
      const data = await api.put(userId, `/trips/${trip_id}`, { is_archived: archived });
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to archive trip'); }
  });

  // delete_trip
  server.tool('delete_trip', 'Permanently delete a trip and all its data', {
    trip_id: z.number().describe('Trip ID'),
  }, async ({ trip_id }) => {
    try {
      const data = await api.delete(userId, `/trips/${trip_id}`);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to delete trip'); }
  });

  // duplicate_trip
  server.tool('duplicate_trip', 'Duplicate a trip (copies days and places, no assignments)', {
    trip_id: z.number().describe('Trip ID to duplicate'),
    title: z.string().optional().describe('Title for the new trip (defaults to "original title (copy)")'),
  }, async ({ trip_id, title }) => {
    try {
      const data = await api.post(userId, `/trips/${trip_id}/duplicate`, { title });
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to duplicate trip'); }
  });
}
