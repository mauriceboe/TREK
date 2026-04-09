import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { canAccessTrip } from '../../db/database';
import { isDemoUser } from '../../services/authService';
import {
  listFiles, getFileById, getDeletedFile, updateFile, toggleStarred,
  softDeleteFile, restoreFile, permanentDeleteFile, emptyTrash,
  createFileLink, deleteFileLink, getFileLinks,
} from '../../services/fileService';
import {
  safeBroadcast, TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_WRITE,
  TOOL_ANNOTATIONS_DELETE,
  demoDenied, noAccess, ok,
} from './_shared';

export function registerFileTools(server: McpServer, userId: number): void {
  // --- FILES ---

  server.registerTool(
    'list_files',
    {
      description: 'List trip files. By default returns active files; set showTrash=true to list the trash instead.',
      inputSchema: {
        tripId: z.number().int().positive(),
        showTrash: z.boolean().optional().default(false).describe('List trash instead of active files'),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId, showTrash }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const files = listFiles(tripId, showTrash ?? false);
      return ok({ files });
    }
  );

  server.registerTool(
    'update_file_metadata',
    {
      description: 'Update a file\'s metadata: description, linked place, or linked reservation.',
      inputSchema: {
        tripId: z.number().int().positive(),
        fileId: z.number().int().positive(),
        description: z.string().max(1000).nullable().optional(),
        place_id: z.number().int().positive().nullable().optional().describe('Link to a place; null to unlink'),
        reservation_id: z.number().int().positive().nullable().optional().describe('Link to a reservation; null to unlink'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, fileId, description, place_id, reservation_id }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const file = getFileById(fileId, tripId);
      if (!file) return { content: [{ type: 'text' as const, text: 'File not found.' }], isError: true };
      const updated = updateFile(fileId, file, {
        description: description !== undefined ? (description ?? undefined) : undefined,
        place_id: place_id !== undefined ? (place_id !== null ? String(place_id) : null) : undefined,
        reservation_id: reservation_id !== undefined ? (reservation_id !== null ? String(reservation_id) : null) : undefined,
      });
      safeBroadcast(tripId, 'file:updated', { file: updated });
      return ok({ file: updated });
    }
  );

  server.registerTool(
    'toggle_file_star',
    {
      description: 'Toggle the starred status of a file (starred files appear at the top).',
      inputSchema: {
        tripId: z.number().int().positive(),
        fileId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, fileId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const file = getFileById(fileId, tripId);
      if (!file) return { content: [{ type: 'text' as const, text: 'File not found.' }], isError: true };
      const updated = toggleStarred(fileId, file.starred);
      safeBroadcast(tripId, 'file:updated', { file: updated });
      return ok({ file: updated });
    }
  );

  server.registerTool(
    'trash_file',
    {
      description: 'Move a file to trash (soft delete). Recoverable with restore_file.',
      inputSchema: {
        tripId: z.number().int().positive(),
        fileId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, fileId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const file = getFileById(fileId, tripId);
      if (!file) return { content: [{ type: 'text' as const, text: 'File not found.' }], isError: true };
      softDeleteFile(fileId);
      safeBroadcast(tripId, 'file:deleted', { fileId });
      return ok({ success: true });
    }
  );

  server.registerTool(
    'restore_file',
    {
      description: 'Restore a file from trash back to the active file list.',
      inputSchema: {
        tripId: z.number().int().positive(),
        fileId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, fileId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const file = getDeletedFile(fileId, tripId);
      if (!file) return { content: [{ type: 'text' as const, text: 'File not found in trash.' }], isError: true };
      const restored = restoreFile(fileId);
      safeBroadcast(tripId, 'file:created', { file: restored });
      return ok({ file: restored });
    }
  );

  server.registerTool(
    'permanent_delete_file',
    {
      description: 'Permanently delete a file from trash. This cannot be undone — the file is removed from disk.',
      inputSchema: {
        tripId: z.number().int().positive(),
        fileId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, fileId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const file = getDeletedFile(fileId, tripId);
      if (!file) return { content: [{ type: 'text' as const, text: 'File not found in trash.' }], isError: true };
      permanentDeleteFile(file);
      safeBroadcast(tripId, 'file:deleted', { fileId });
      return ok({ success: true });
    }
  );

  server.registerTool(
    'empty_trash',
    {
      description: 'Permanently delete all files in the trash for a trip. Cannot be undone.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const deleted = emptyTrash(tripId);
      return ok({ success: true, deleted });
    }
  );

  server.registerTool(
    'link_file',
    {
      description: 'Link a file to a place, reservation, or assignment. The file must belong to the trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        fileId: z.number().int().positive(),
        place_id: z.number().int().positive().optional(),
        reservation_id: z.number().int().positive().optional(),
        assignment_id: z.number().int().positive().optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, fileId, place_id, reservation_id, assignment_id }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const file = getFileById(fileId, tripId);
      if (!file) return { content: [{ type: 'text' as const, text: 'File not found.' }], isError: true };
      const links = createFileLink(fileId, {
        place_id: place_id ? String(place_id) : null,
        reservation_id: reservation_id ? String(reservation_id) : null,
        assignment_id: assignment_id ? String(assignment_id) : null,
      });
      return ok({ success: true, links });
    }
  );

  server.registerTool(
    'unlink_file',
    {
      description: 'Remove a specific link between a file and a place/reservation/assignment. Use list_file_links to get the link ID.',
      inputSchema: {
        tripId: z.number().int().positive(),
        fileId: z.number().int().positive(),
        linkId: z.number().int().positive().describe('ID of the file link to remove'),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, fileId, linkId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const file = getFileById(fileId, tripId);
      if (!file) return { content: [{ type: 'text' as const, text: 'File not found.' }], isError: true };
      deleteFileLink(linkId, fileId);
      return ok({ success: true });
    }
  );

  server.registerTool(
    'list_file_links',
    {
      description: 'List all entity links for a file (places, reservations, assignments it is attached to).',
      inputSchema: {
        tripId: z.number().int().positive(),
        fileId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId, fileId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const file = getFileById(fileId, tripId);
      if (!file) return { content: [{ type: 'text' as const, text: 'File not found.' }], isError: true };
      const links = getFileLinks(fileId);
      return ok({ links });
    }
  );
}
