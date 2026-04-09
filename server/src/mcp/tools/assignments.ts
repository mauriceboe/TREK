import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { canAccessTrip } from '../../db/database';
import { isDemoUser } from '../../services/authService';
import {
  dayExists, placeExists, createAssignment, assignmentExistsInDay,
  deleteAssignment, reorderAssignments, getAssignmentForTrip, updateTime,
  moveAssignment,
  getParticipants as getAssignmentParticipants,
  setParticipants as setAssignmentParticipants,
} from '../../services/assignmentService';
import { getDay } from '../../services/dayService';
import {
  safeBroadcast, TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_WRITE, TOOL_ANNOTATIONS_DELETE,
  TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  demoDenied, noAccess, ok,
} from './_shared';

export function registerAssignmentTools(server: McpServer, userId: number): void {
  // --- ASSIGNMENTS ---

  server.registerTool(
    'assign_place_to_day',
    {
      description: 'Assign a place to a specific day in a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        placeId: z.number().int().positive(),
        notes: z.string().max(500).optional(),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, dayId, placeId, notes }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (!dayExists(dayId, tripId)) return { content: [{ type: 'text' as const, text: 'Day not found.' }], isError: true };
      if (!placeExists(placeId, tripId)) return { content: [{ type: 'text' as const, text: 'Place not found.' }], isError: true };
      const assignment = createAssignment(dayId, placeId, notes || null);
      safeBroadcast(tripId, 'assignment:created', { assignment });
      return ok({ assignment });
    }
  );

  server.registerTool(
    'unassign_place',
    {
      description: 'Remove a place assignment from a day.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        assignmentId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, dayId, assignmentId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (!assignmentExistsInDay(assignmentId, dayId, tripId))
        return { content: [{ type: 'text' as const, text: 'Assignment not found.' }], isError: true };
      deleteAssignment(assignmentId);
      safeBroadcast(tripId, 'assignment:deleted', { assignmentId, dayId });
      return ok({ success: true });
    }
  );

  server.registerTool(
    'update_assignment_time',
    {
      description: 'Set the start and/or end time for a place assignment on a day (e.g. "09:00", "11:30"). Pass null to clear a time.',
      inputSchema: {
        tripId: z.number().int().positive(),
        assignmentId: z.number().int().positive(),
        place_time: z.string().max(50).nullable().optional().describe('Start time (e.g. "09:00"), or null to clear'),
        end_time: z.string().max(50).nullable().optional().describe('End time (e.g. "11:00"), or null to clear'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, assignmentId, place_time, end_time }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = getAssignmentForTrip(assignmentId, tripId);
      if (!existing) return { content: [{ type: 'text' as const, text: 'Assignment not found.' }], isError: true };
      const assignment = updateTime(
        assignmentId,
        place_time !== undefined ? place_time : (existing as any).assignment_time,
        end_time !== undefined ? end_time : (existing as any).assignment_end_time
      );
      safeBroadcast(tripId, 'assignment:updated', { assignment });
      return ok({ assignment });
    }
  );

  server.registerTool(
    'move_assignment',
    {
      description: 'Move a place assignment to a different day.',
      inputSchema: {
        tripId: z.number().int().positive(),
        assignmentId: z.number().int().positive(),
        newDayId: z.number().int().positive(),
        oldDayId: z.number().int().positive(),
        orderIndex: z.number().int().min(0).optional().default(0),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, assignmentId, newDayId, oldDayId, orderIndex }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const result = moveAssignment(assignmentId, newDayId, orderIndex ?? 0, oldDayId);
      safeBroadcast(tripId, 'assignment:moved', { assignment: result.assignment, oldDayId: result.oldDayId });
      return ok({ assignment: result.assignment });
    }
  );

  server.registerTool(
    'get_assignment_participants',
    {
      description: 'Get the list of users participating in a specific place assignment.',
      inputSchema: {
        tripId: z.number().int().positive(),
        assignmentId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId, assignmentId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const participants = getAssignmentParticipants(assignmentId);
      return ok({ participants });
    }
  );

  server.registerTool(
    'set_assignment_participants',
    {
      description: 'Set the participants for a place assignment (replaces current list).',
      inputSchema: {
        tripId: z.number().int().positive(),
        assignmentId: z.number().int().positive(),
        userIds: z.array(z.number().int().positive()).describe('User IDs to set as participants; empty array clears all'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, assignmentId, userIds }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const participants = setAssignmentParticipants(assignmentId, userIds);
      safeBroadcast(tripId, 'assignment:participants', { assignmentId, participants });
      return ok({ participants });
    }
  );

  // --- REORDER ---

  server.registerTool(
    'reorder_day_assignments',
    {
      description: 'Reorder places within a day by providing the assignment IDs in the desired order.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        assignmentIds: z.array(z.number().int().positive()).min(1).max(200).describe('Assignment IDs in desired display order'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, dayId, assignmentIds }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (!getDay(dayId, tripId)) return { content: [{ type: 'text' as const, text: 'Day not found.' }], isError: true };
      reorderAssignments(dayId, assignmentIds);
      safeBroadcast(tripId, 'assignment:reordered', { dayId, assignmentIds });
      return ok({ success: true, dayId, order: assignmentIds });
    }
  );
}
