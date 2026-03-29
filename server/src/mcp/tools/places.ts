import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { api, ok, mcpErr } from '../apiClient';

export function registerPlaceTools(server: McpServer, userId: number): void {

  // list_places
  server.tool('list_places', 'List all places for a trip', {
    trip_id: z.number().describe('Trip ID'),
    category_id: z.number().optional().describe('Filter by category ID'),
  }, async ({ trip_id, category_id }) => {
    try {
      const path = `/trips/${trip_id}/places${category_id !== undefined ? `?category_id=${category_id}` : ''}`;
      const data = await api.get(userId, path) as { places: unknown[] };
      return ok(data.places ?? data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Trip not found or access denied'); }
  });

  // get_place
  server.tool('get_place', 'Get details of a specific place', {
    trip_id: z.number().describe('Trip ID'),
    place_id: z.number().describe('Place ID'),
  }, async ({ trip_id, place_id }) => {
    try {
      const data = await api.get(userId, `/trips/${trip_id}/places/${place_id}`);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Place not found'); }
  });

  // create_place
  server.tool('create_place', 'Add a new place to a trip', {
    trip_id: z.number().describe('Trip ID'),
    name: z.string().describe('Place name'),
    address: z.string().optional().describe('Address'),
    lat: z.number().optional().describe('Latitude'),
    lng: z.number().optional().describe('Longitude'),
    category_id: z.number().optional().describe('Category ID'),
    notes: z.string().optional().describe('Notes about the place'),
    website: z.string().optional().describe('Website URL'),
    phone: z.string().optional().describe('Phone number'),
    price: z.number().optional().describe('Price/cost'),
    duration_minutes: z.number().optional().describe('Expected visit duration in minutes'),
    place_time: z.string().optional().describe('Planned visit time (HH:MM)'),
    transport_mode: z.enum(['walking', 'driving', 'transit', 'cycling']).optional().describe('Transport mode to this place'),
  }, async ({ trip_id, ...body }) => {
    try {
      const data = await api.post(userId, `/trips/${trip_id}/places`, body);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to create place'); }
  });

  // update_place
  server.tool('update_place', 'Update a place\'s details', {
    trip_id: z.number().describe('Trip ID'),
    place_id: z.number().describe('Place ID'),
    name: z.string().optional(),
    address: z.string().optional(),
    notes: z.string().optional(),
    website: z.string().optional(),
    phone: z.string().optional(),
    price: z.number().optional(),
    duration_minutes: z.number().optional(),
    place_time: z.string().optional().describe('Planned visit time (HH:MM)'),
    category_id: z.number().optional(),
    transport_mode: z.enum(['walking', 'driving', 'transit', 'cycling']).optional(),
  }, async ({ trip_id, place_id, ...updates }) => {
    try {
      const data = await api.put(userId, `/trips/${trip_id}/places/${place_id}`, updates);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to update place'); }
  });

  // delete_place
  server.tool('delete_place', 'Delete a place from a trip', {
    trip_id: z.number().describe('Trip ID'),
    place_id: z.number().describe('Place ID'),
  }, async ({ trip_id, place_id }) => {
    try {
      const data = await api.delete(userId, `/trips/${trip_id}/places/${place_id}`);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to delete place'); }
  });

  // assign_to_day
  server.tool('assign_to_day', 'Schedule a place on a specific day', {
    trip_id: z.number().describe('Trip ID'),
    place_id: z.number().describe('Place ID'),
    day_number: z.number().describe('Day number (1-based)'),
    order_index: z.number().optional().describe('Position in the day schedule (0-based, appends if omitted)'),
    notes: z.string().optional().describe('Notes for this assignment'),
  }, async ({ trip_id, place_id, day_number, order_index, notes }) => {
    try {
      // Find the day ID by its number
      const listData = await api.get(userId, `/trips/${trip_id}/days`) as { days: Array<{ id: number; day_number: number }> };
      const day = (listData.days ?? []).find(d => d.day_number === day_number);
      if (!day) return mcpErr(`Day ${day_number} not found`);
      const data = await api.post(userId, `/trips/${trip_id}/days/${day.id}/assignments`, { place_id, order_index, notes });
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to assign place to day'); }
  });

  // unassign_from_day
  server.tool('unassign_from_day', 'Remove a place from a day\'s schedule', {
    trip_id: z.number().describe('Trip ID'),
    place_id: z.number().describe('Place ID'),
    day_number: z.number().describe('Day number (1-based)'),
  }, async ({ trip_id, place_id, day_number }) => {
    try {
      // Get days with their assignments to find the assignment ID
      const listData = await api.get(userId, `/trips/${trip_id}/days`) as {
        days: Array<{ id: number; day_number: number; assignments: Array<{ id: number; place: { id: number } }> }>
      };
      const day = (listData.days ?? []).find(d => d.day_number === day_number);
      if (!day) return mcpErr(`Day ${day_number} not found`);
      const assignment = (day.assignments ?? []).find(a => a.place?.id === place_id);
      if (!assignment) return mcpErr(`Place ${place_id} is not assigned to day ${day_number}`);
      const data = await api.delete(userId, `/trips/${trip_id}/days/${day.id}/assignments/${assignment.id}`);
      return ok(data);
    } catch (e) { return mcpErr(e instanceof Error ? e.message : 'Failed to unassign place'); }
  });
}
