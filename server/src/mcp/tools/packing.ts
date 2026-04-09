import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { canAccessTrip } from '../../db/database';
import { isDemoUser } from '../../services/authService';
import {
  createItem as createPackingItem, updateItem as updatePackingItem,
  deleteItem as deletePackingItem,
  reorderItems as reorderPackingItems,
  listBags, createBag, updateBag, deleteBag, setBagMembers,
  getCategoryAssignees as getPackingCategoryAssignees,
  updateCategoryAssignees as updatePackingCategoryAssignees,
  applyTemplate, saveAsTemplate, bulkImport,
} from '../../services/packingService';
import {
  safeBroadcast, TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_WRITE, TOOL_ANNOTATIONS_DELETE,
  TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  demoDenied, noAccess, ok,
} from './_shared';

export function registerPackingTools(server: McpServer, userId: number): void {
  // --- PACKING ---

  server.registerTool(
    'create_packing_item',
    {
      description: 'Add an item to the packing checklist for a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        name: z.string().min(1).max(200),
        category: z.string().max(100).optional().describe('Packing category (e.g. Clothes, Electronics)'),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, name, category }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = createPackingItem(tripId, { name, category: category || 'General' });
      safeBroadcast(tripId, 'packing:created', { item });
      return ok({ item });
    }
  );

  server.registerTool(
    'toggle_packing_item',
    {
      description: 'Check or uncheck a packing item.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
        checked: z.boolean(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, itemId, checked }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = updatePackingItem(tripId, itemId, { checked: checked ? 1 : 0 }, ['checked']);
      if (!item) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      safeBroadcast(tripId, 'packing:updated', { item });
      return ok({ item });
    }
  );

  server.registerTool(
    'delete_packing_item',
    {
      description: 'Remove an item from the packing checklist.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, itemId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const deleted = deletePackingItem(tripId, itemId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      safeBroadcast(tripId, 'packing:deleted', { itemId });
      return ok({ success: true });
    }
  );

  // --- PACKING (update) ---

  server.registerTool(
    'update_packing_item',
    {
      description: 'Rename a packing item or change its category.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
        name: z.string().min(1).max(200).optional(),
        category: z.string().max(100).optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, itemId, name, category }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const bodyKeys = ['name', 'category'].filter(k => k === 'name' ? name !== undefined : category !== undefined);
      const item = updatePackingItem(tripId, itemId, { name, category }, bodyKeys);
      if (!item) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      safeBroadcast(tripId, 'packing:updated', { item });
      return ok({ item });
    }
  );

  // --- PACKING ADVANCED ---

  server.registerTool(
    'reorder_packing_items',
    {
      description: 'Set the display order of packing items within a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        orderedIds: z.array(z.number().int().positive()).describe('Packing item IDs in desired order'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, orderedIds }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      reorderPackingItems(tripId, orderedIds);
      safeBroadcast(tripId, 'packing:reordered', { orderedIds });
      return ok({ success: true });
    }
  );

  server.registerTool(
    'list_packing_bags',
    {
      description: 'List all packing bags for a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const bags = listBags(tripId);
      return ok({ bags });
    }
  );

  server.registerTool(
    'create_packing_bag',
    {
      description: 'Create a new packing bag (e.g. "Carry-on", "Checked bag").',
      inputSchema: {
        tripId: z.number().int().positive(),
        name: z.string().min(1).max(100),
        color: z.string().optional(),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, name, color }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const bag = createBag(tripId, { name, color });
      safeBroadcast(tripId, 'packing:bag-created', { bag });
      return ok({ bag });
    }
  );

  server.registerTool(
    'update_packing_bag',
    {
      description: 'Rename or recolor a packing bag.',
      inputSchema: {
        tripId: z.number().int().positive(),
        bagId: z.number().int().positive(),
        name: z.string().optional(),
        color: z.string().optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, bagId, name, color }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const fields: Record<string, unknown> = {};
      const bodyKeys: string[] = [];
      if (name !== undefined) { fields.name = name; bodyKeys.push('name'); }
      if (color !== undefined) { fields.color = color; bodyKeys.push('color'); }
      const bag = updateBag(tripId, bagId, fields, bodyKeys);
      safeBroadcast(tripId, 'packing:bag-updated', { bag });
      return ok({ bag });
    }
  );

  server.registerTool(
    'delete_packing_bag',
    {
      description: 'Delete a packing bag (items in the bag are unassigned, not deleted).',
      inputSchema: {
        tripId: z.number().int().positive(),
        bagId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, bagId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      deleteBag(tripId, bagId);
      safeBroadcast(tripId, 'packing:bag-deleted', { id: bagId });
      return ok({ success: true });
    }
  );

  server.registerTool(
    'set_bag_members',
    {
      description: 'Assign trip members to a packing bag (determines who packs what bag).',
      inputSchema: {
        tripId: z.number().int().positive(),
        bagId: z.number().int().positive(),
        userIds: z.array(z.number().int().positive()),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, bagId, userIds }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      setBagMembers(tripId, bagId, userIds);
      safeBroadcast(tripId, 'packing:bag-members-updated', { bagId, userIds });
      return ok({ success: true });
    }
  );

  server.registerTool(
    'get_packing_category_assignees',
    {
      description: 'Get which trip members are assigned to each packing category.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const assignees = getPackingCategoryAssignees(tripId);
      return ok({ assignees });
    }
  );

  server.registerTool(
    'set_packing_category_assignees',
    {
      description: 'Assign trip members to a packing category.',
      inputSchema: {
        tripId: z.number().int().positive(),
        categoryName: z.string().min(1).max(100),
        userIds: z.array(z.number().int().positive()),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, categoryName, userIds }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      updatePackingCategoryAssignees(tripId, categoryName, userIds);
      safeBroadcast(tripId, 'packing:assignees', { categoryName, userIds });
      return ok({ success: true });
    }
  );

  server.registerTool(
    'apply_packing_template',
    {
      description: 'Apply a packing template to a trip (adds items from the template).',
      inputSchema: {
        tripId: z.number().int().positive(),
        templateId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, templateId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const applied = applyTemplate(tripId, templateId);
      if (applied === null) return { content: [{ type: 'text' as const, text: 'Template not found.' }], isError: true };
      safeBroadcast(tripId, 'packing:template-applied', { templateId });
      return ok({ success: true });
    }
  );

  server.registerTool(
    'save_packing_template',
    {
      description: 'Save the current packing list as a reusable template.',
      inputSchema: {
        tripId: z.number().int().positive(),
        templateName: z.string().min(1).max(100),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, templateName }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      saveAsTemplate(tripId, userId, templateName);
      return ok({ success: true });
    }
  );

  server.registerTool(
    'bulk_import_packing',
    {
      description: 'Import multiple packing items at once from a list.',
      inputSchema: {
        tripId: z.number().int().positive(),
        items: z.array(z.object({
          name: z.string().min(1).max(200),
          category: z.string().optional(),
          quantity: z.number().int().positive().optional(),
        })).min(1),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, items }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      bulkImport(tripId, items);
      safeBroadcast(tripId, 'packing:updated', {});
      return ok({ success: true, count: items.length });
    }
  );
}
