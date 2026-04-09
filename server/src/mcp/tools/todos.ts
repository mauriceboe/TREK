import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { canAccessTrip } from '../../db/database';
import { isDemoUser } from '../../services/authService';
import {
  listItems as listTodoItems, createItem as createTodoItem, updateItem as updateTodoItem,
  deleteItem as deleteTodoItem, reorderItems as reorderTodoItems,
  getCategoryAssignees as getTodoCategoryAssignees, updateCategoryAssignees as updateTodoCategoryAssignees,
} from '../../services/todoService';
import {
  safeBroadcast, TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_WRITE,
  TOOL_ANNOTATIONS_DELETE, TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  demoDenied, noAccess, ok,
} from './_shared';

export function registerTodoTools(server: McpServer, userId: number): void {
  // --- TODOS ---

  server.registerTool(
    'list_todos',
    {
      description: 'List all to-do items for a trip, ordered by position.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const items = listTodoItems(tripId);
      return ok({ items });
    }
  );

  server.registerTool(
    'create_todo',
    {
      description: 'Create a new to-do item for a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        name: z.string().min(1).max(500).describe('To-do item name'),
        category: z.string().max(100).optional().describe('Category (e.g. "Logistics", "Booking")'),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Due date (YYYY-MM-DD)'),
        description: z.string().max(2000).optional().describe('Additional description'),
        assigned_user_id: z.number().int().positive().optional().describe('User ID to assign this task to'),
        priority: z.number().int().min(0).max(3).optional().describe('Priority: 0=none, 1=low, 2=medium, 3=high'),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, name, category, due_date, description, assigned_user_id, priority }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = createTodoItem(tripId, { name, category, due_date, description, assigned_user_id, priority });
      safeBroadcast(tripId, 'todo:created', { item });
      return ok({ item });
    }
  );

  server.registerTool(
    'update_todo',
    {
      description: 'Update an existing to-do item. Only provided fields are changed; omitted fields stay as-is. Pass null to clear a nullable field.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
        name: z.string().min(1).max(500).optional(),
        category: z.string().max(100).optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('Set to null to clear the due date'),
        description: z.string().max(2000).nullable().optional().describe('Set to null to clear'),
        assigned_user_id: z.number().int().positive().nullable().optional().describe('Set to null to unassign'),
        priority: z.number().int().min(0).max(3).nullable().optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, itemId, name, category, due_date, description, assigned_user_id, priority }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      // Build bodyKeys to signal which nullable fields were explicitly provided
      const bodyKeys: string[] = [];
      if (due_date !== undefined) bodyKeys.push('due_date');
      if (description !== undefined) bodyKeys.push('description');
      if (assigned_user_id !== undefined) bodyKeys.push('assigned_user_id');
      if (priority !== undefined) bodyKeys.push('priority');
      const item = updateTodoItem(tripId, itemId, { name, category, due_date, description, assigned_user_id, priority }, bodyKeys);
      if (!item) return { content: [{ type: 'text' as const, text: 'To-do item not found.' }], isError: true };
      safeBroadcast(tripId, 'todo:updated', { item });
      return ok({ item });
    }
  );

  server.registerTool(
    'toggle_todo',
    {
      description: 'Mark a to-do item as checked (done) or unchecked.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
        checked: z.boolean().describe('True to mark done, false to uncheck'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, itemId, checked }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = updateTodoItem(tripId, itemId, { checked: checked ? 1 : 0 }, []);
      if (!item) return { content: [{ type: 'text' as const, text: 'To-do item not found.' }], isError: true };
      safeBroadcast(tripId, 'todo:updated', { item });
      return ok({ item });
    }
  );

  server.registerTool(
    'delete_todo',
    {
      description: 'Delete a to-do item.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, itemId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const deleted = deleteTodoItem(tripId, itemId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'To-do item not found.' }], isError: true };
      safeBroadcast(tripId, 'todo:deleted', { itemId });
      return ok({ success: true });
    }
  );

  server.registerTool(
    'reorder_todos',
    {
      description: 'Reorder to-do items within a trip by providing a new ordered list of item IDs.',
      inputSchema: {
        tripId: z.number().int().positive(),
        orderedIds: z.array(z.number().int().positive()).min(1).describe('All item IDs in the desired order'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, orderedIds }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      reorderTodoItems(tripId, orderedIds);
      return ok({ success: true });
    }
  );

  server.registerTool(
    'get_todo_category_assignees',
    {
      description: 'Get the default assignees configured per to-do category for a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const assignees = getTodoCategoryAssignees(tripId);
      return ok({ assignees });
    }
  );

  server.registerTool(
    'set_todo_category_assignees',
    {
      description: 'Set the default assignees for a to-do category on a trip. Pass an empty array to clear.',
      inputSchema: {
        tripId: z.number().int().positive(),
        categoryName: z.string().min(1).max(100).describe('Category name'),
        userIds: z.array(z.number().int().positive()).describe('User IDs to assign as defaults for this category'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, categoryName, userIds }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const assignees = updateTodoCategoryAssignees(tripId, categoryName, userIds);
      safeBroadcast(tripId, 'todo:assignees', { category: categoryName, assignees });
      return ok({ assignees });
    }
  );
}
